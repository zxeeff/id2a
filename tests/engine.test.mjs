import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine, createRun } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { acquireLock, readJSON, readText, sleep, writeJSON } from '../src/util.mjs';
import { fixture, task, workerResult, verdict, scriptedFactory, defaultResult } from './helpers.mjs';

test('scheduler honors concurrency and dependencies with independent reviewers', async t => {
  const env = fixture(t, { workers: 2 });
  let running = 0, maximum = 0;
  const seen = [];
  const factory = scriptedFactory(async message => {
    const { role, data } = message;
    if (role === 'planner') return { summary: 'Three checks', tasks: [
      { ...task('One'), depends_on: [] }, { ...task('Two'), depends_on: [] }, { ...task('Three'), depends_on: [0, 1] },
    ] };
    if (role === 'worker') {
      running++; maximum = Math.max(maximum, running); seen.push('worker-' + data.task.id);
      await sleep(70); running--;
      return workerResult(env.workspace);
    }
    if (role === 'supervisor') seen.push('review-' + data.task.id);
    return defaultResult(message);
  });
  const engine = new Engine(env.run, { providerFactory: factory }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(maximum, 2);
  assert(seen.indexOf('worker-3') > seen.indexOf('review-1'));
  assert(seen.indexOf('worker-3') > seen.indexOf('review-2'));
  assert.equal(engine.store.listFacts({ state: 'verified' }).length, 1);
  assert.equal(engine.store.fact(1).origins.length, 3);
  assert(fs.existsSync(path.join(env.run, 'report.md')));
});

test('a stalled approach triggers another goal cycle instead of ending the run', async t => {
  const env = fixture(t, { maxRevisions: 1 });
  let workers = 0, goalReviews = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') { workers++; return workerResult(env.workspace); }
    if (message.role === 'supervisor' && message.data.task.id === 1) return verdict(message.data.facts.map(fact => fact.id), 'unresolved', 'revise');
    if (message.role === 'goal') {
      goalReviews++;
      if (!message.data.context.tasks.some(item => item.state === 'accepted')) return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The stalled approach did not establish this requirement.' })),
        reason: 'The first approach stalled.', progress: 'Evidence collection needs an alternative.',
        next_tasks: [{ title: 'Alternative check', brief: 'Verify the runtime requirement with a fresh approach.', scope: 'docs.runtime.recovery', depends_on: [] }], question: '',
      };
    }
    return defaultResult(message);
  });
  const engine = new Engine(env.run, { providerFactory: factory }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(workers, 3);
  assert.equal(engine.store.task(1).state, 'stalled');
  assert.equal(engine.store.task(2).state, 'accepted');
  assert.equal(goalReviews, 2);
});

test('accepted followups pass triage, deduplicate, and stay within task budget', async t => {
  const env = fixture(t, { maxTasks: 2 });
  let triages = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') {
      const result = workerResult(env.workspace);
      if (message.data.task.id === 1) result.followups = [task('Followup'), task('Followup')];
      return result;
    }
    if (message.role === 'triage') { triages++; return { decision: 'approve', reason: 'In scope' }; }
    return defaultResult(message);
  });
  const engine = new Engine(env.run, { providerFactory: factory }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(engine.store.tasks().length, 2);
  assert.equal(triages, 1);
  assert.deepEqual(engine.store.task(2).dependencies, [1]);
});

test('followup triage deferred by an attempt boundary is retried and executed in the same run', async t => {
  const env = fixture(t, { maxAttempts: 3, workers: 1, maxTasks: 3 });
  let triages = 0;
  const workerScopes = [];
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') {
      workerScopes.push(message.data.task.scope);
      const result = workerResult(env.workspace, `Node.js 24 evidence for task ${message.data.task.id}.`, `docs.runtime.followup.${message.data.task.id}`);
      if (message.data.task.id === 1) result.followups = [
        { title: 'First followup', brief: 'Run the first derived verification.', scope: 'docs.runtime.followup.first' },
        { title: 'Deferred followup', brief: 'Run the derived verification after the attempt boundary.', scope: 'docs.runtime.followup.deferred' },
      ];
      return result;
    }
    if (message.role === 'triage') { triages++; return { decision: 'approve', reason: 'Required derived verification.' }; }
    return defaultResult(message);
  });
  const engine = new Engine(env.run, { providerFactory: factory }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  const deferred = engine.store.tasks().find(item => item.scope === 'docs.runtime.followup.deferred');
  assert(deferred);
  assert.equal(deferred.state, 'accepted');
  assert(workerScopes.includes('docs.runtime.followup.deferred'));
  assert.equal(triages, 2);
  assert.equal(engine.store.getMeta('followups:1'), true);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  const events = engine.store.events(0, 1000);
  const triageAttempts = events.filter(event => event.type === 'agent.started' && event.role === 'triage').map(event => event.attempt);
  assert.equal(triageAttempts.length, 2);
  assert(events.some(event => event.type === 'run.segment_advanced' && event.reason === 'segment_budget_exhausted'
    && event.segment_start_attempt >= triageAttempts[0] && event.segment_start_attempt < triageAttempts[1]));
});

test('a transient triage failure backs off and executes the pending followup before Goal achievement', async t => {
  const env = fixture(t, { workers: 1, maxTasks: 3 });
  let triages = 0, goalSawAcceptedFollowup = false;
  const workerScopes = [];
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') {
      workerScopes.push(message.data.task.scope);
      const result = workerResult(env.workspace, `Runtime evidence from ${message.data.task.scope}.`, `docs.runtime.transient.${message.data.task.id}`);
      if (message.data.task.id === 1) result.followups = [
        { title: 'Retry triaged followup', brief: 'Run the followup after transient triage recovery.', scope: 'docs.runtime.followup.retry' },
      ];
      return result;
    }
    if (message.role === 'triage' && ++triages === 1) throw new Error('transient triage provider failure');
    if (message.role === 'triage') return { decision: 'approve', reason: 'The recovered followup is required.' };
    if (message.role === 'goal') {
      goalSawAcceptedFollowup = message.data.context.tasks.some(item => item.scope === 'docs.runtime.followup.retry' && item.state === 'accepted');
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());

  assert.equal(await engine.run(), 'completed');
  assert.equal(triages, 2);
  assert.equal(goalSawAcceptedFollowup, true);
  assert(workerScopes.includes('docs.runtime.followup.retry'));
  assert.equal(engine.store.tasks().find(item => item.scope === 'docs.runtime.followup.retry')?.state, 'accepted');
  const events = engine.store.events(0, 1000);
  assert(events.some(event => event.type === 'followup.failed' && event.task === 1));
  assert(events.some(event => event.type === 'control.retry_scheduled' && event.stage === 'followup'));
  const goalAttempt = events.find(event => event.type === 'agent.started' && event.role === 'goal')?.attempt;
  const followupWorkerAttempt = events.find(event => event.type === 'agent.started' && event.role === 'worker' && event.task === 2)?.attempt;
  assert(Number.isSafeInteger(goalAttempt) && Number.isSafeInteger(followupWorkerAttempt) && followupWorkerAttempt < goalAttempt);
});

test('a new worker submission clears the old followup marker and processes its new followups', async t => {
  const env = fixture(t, { workers: 1, maxTasks: 3 });
  const first = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) });
  try {
    assert.equal(await first.run(), 'completed');
    assert.equal(first.store.getMeta('followups:1'), true);
  } finally { first.close(); }

  const store = new Store(env.run);
  try { store.message('Re-run this task and process followups from the new submission.', 1); }
  finally { store.close(); }

  let triages = 0, parentWorkers = 0, followupWorkers = 0;
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker' && message.data.task.id === 1) {
      parentWorkers++;
      const result = workerResult(env.workspace, 'The revised submission found another required check.', 'docs.runtime.revised');
      result.followups = [{ title: 'New submission followup', brief: 'Verify the followup discovered by the revised submission.', scope: 'docs.runtime.revised.followup' }];
      return result;
    }
    if (message.role === 'worker') { followupWorkers++; return workerResult(env.workspace); }
    if (message.role === 'triage') { triages++; return { decision: 'approve', reason: 'Required by the revised submission.' }; }
    return defaultResult(message);
  }) });
  try {
    assert.equal(await resumed.run(), 'completed');
    assert.equal(parentWorkers, 1);
    assert.equal(triages, 1);
    assert.equal(followupWorkers, 1);
    assert.equal(resumed.store.tasks().find(item => item.scope === 'docs.runtime.revised.followup')?.state, 'accepted');
    assert.equal(resumed.store.getMeta('followups:1'), true);
  } finally { resumed.close(); }
});

test('followup triage is renewed for worker and contract generations and revives approved terminal duplicates', async t => {
  const env = fixture(t);
  const candidate = { title: 'Generation-sensitive followup', brief: 'Reassess this followup in the current generation.', scope: 'docs.runtime.generation' };
  let triages = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'triage') {
      triages++;
      return { decision: triages === 1 ? 'reject' : 'approve', reason: `Generation review ${triages}.` };
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  await engine.ensureGoalContract();
  assert.equal(engine.store.getMeta('goal:contract').revision, 1);
  const parent = engine.store.addTask(task('Parent task'));
  const duplicate = engine.store.addTask(candidate, { dependencies: [parent] });
  engine.store.updateTask(parent, { state: 'accepted', result: {
    summary: 'The parent discovered a followup.', artifacts: [], facts: [], fact_ids: [], followups: [candidate],
  } });
  engine.store.updateTask(duplicate, { state: 'rejected', result: { summary: 'Old terminal result' }, revisions: 2, failures: 2 });

  await engine.followups(engine.store.task(parent));
  const firstGeneration = engine.store.getMeta(`followups:generation:${parent}`);
  assert.equal(triages, 1);
  assert.equal(engine.store.task(duplicate).state, 'rejected');

  engine.store.setMeta(`worker:generation:${parent}`, 1);
  await engine.followups(engine.store.task(parent));
  const workerGeneration = engine.store.getMeta(`followups:generation:${parent}`);
  assert.equal(triages, 2);
  assert.notEqual(workerGeneration, firstGeneration);
  assert.equal(engine.store.getMeta('goal:contract').revision, 1);
  assert.equal(engine.store.task(duplicate).state, 'queued');
  assert.equal(engine.store.task(duplicate).result, null);
  assert.equal(engine.store.task(duplicate).revisions, 0);
  assert.equal(engine.store.task(duplicate).failures, 0);

  engine.store.updateTask(duplicate, { state: 'stalled', result: { summary: 'Terminal in the prior contract context' }, revisions: 1, failures: 1 });
  engine.store.message('Reassess derived work under this new contract context.');
  await engine.ensureGoalContract();
  assert.equal(engine.store.getMeta('goal:contract').revision, 2);
  await engine.followups(engine.store.task(parent));
  const contractGeneration = engine.store.getMeta(`followups:generation:${parent}`);
  assert.equal(triages, 3);
  assert.notEqual(contractGeneration, workerGeneration);
  assert.equal(engine.store.task(duplicate).state, 'queued');
  assert.equal(engine.store.task(duplicate).result, null);
  assert.equal(engine.store.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'triage:%'").get().count, 3);
  const approvals = engine.store.events(0, 1000).filter(event => event.type === 'followup.approved' && event.followup === duplicate);
  assert.equal(approvals.length, 2);
  assert(approvals.every(event => event.recovered === true));
});

test('a global instruction before followup triage requires review under the committed contract', async t => {
  const env = fixture(t, { workers: 1, maxTasks: 3 });
  const instruction = 'Require the followup to be reviewed under the updated contract.';
  const triageRevisions = [];
  let engine, instructionAdded = false;
  const factory = scriptedFactory(message => {
    if (message.role === 'contract' && message.data.user_instructions.some(item => item.text === instruction)) {
      const result = defaultResult(message);
      result.requirements.push({
        type: 'constraint', statement: 'Review the followup under the updated contract.', source_reference: instruction,
        verification: 'Verify that followup triage used the committed updated contract.',
      });
      return result;
    }
    if (message.role === 'worker') {
      const result = workerResult(env.workspace, `Runtime evidence from task ${message.data.task.id}.`, `docs.runtime.contract_followup.${message.data.task.id}`);
      if (message.data.task.id === 1) result.followups = [
        { title: 'Contract-sensitive followup', brief: 'Review this followup under the current committed contract.', scope: 'docs.runtime.contract_followup' },
      ];
      return result;
    }
    if (message.role === 'triage') {
      triageRevisions.push(message.data.contract.revision);
      return { decision: 'approve', reason: `Approved under contract revision ${message.data.contract.revision}.` };
    }
    return defaultResult(message);
  });
  engine = new Engine(env.run, {
    providerFactory: factory,
    onEvent: event => {
      if (!instructionAdded && event.type === 'task.state' && event.task === 1 && event.state === 'accepted') {
        instructionAdded = true;
        engine.store.message(instruction);
      }
    },
  }); env.dispose(() => engine.close());

  assert.equal(await engine.run(), 'completed');
  assert.equal(instructionAdded, true);
  assert.equal(engine.store.getMeta('goal:contract').revision, 2);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(triageRevisions.at(-1), 2);
});

test('corrupt and semantically invalid saved plans are quarantined and regenerated in the same run', async t => {
  const scenarios = [
    { name: 'corrupt JSON', write: file => fs.writeFileSync(file, '{ invalid json', 'utf8') },
    { name: 'forward dependency', write: file => writeJSON(file, {
      summary: 'Invalid saved plan', tasks: [{ ...task('Invalid saved task'), depends_on: [0] }],
    }) },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const env = fixture(t);
    const planPath = path.join(env.run, 'plan.json');
    scenario.write(planPath);
    let plannerCalls = 0;
    const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      if (message.role === 'planner') plannerCalls++;
      if (message.role === 'worker') return workerResult(env.workspace);
      return defaultResult(message);
    }) }); env.dispose(() => engine.close());

    assert.equal(await engine.run(), 'completed');
    assert.equal(plannerCalls, 1);
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
    assert.deepEqual(readJSON(planPath).tasks[0].depends_on, []);
    const quarantined = fs.readdirSync(env.run).filter(file => /^plan\.invalid-\d+\.json$/u.test(file));
    assert.equal(quarantined.length, 1);
    assert(fs.existsSync(path.join(env.run, quarantined[0])));
    const invalidated = engine.store.events(0, 1000).filter(event => event.type === 'plan.invalidated');
    assert.equal(invalidated.length, 1);
    assert.equal(path.resolve(invalidated[0].path), path.resolve(env.run, quarantined[0]));
  });
});

test('runAgent closes an attempt as failed when prompt setup throws', async t => {
  const env = fixture(t);
  let providerCalls = 0;
  const engine = new Engine(env.run, { providerFactory: () => {
    providerCalls++;
    throw new Error('provider must not be created after a prompt setup failure');
  } }); env.dispose(() => engine.close());
  engine.store.setMeta('control:lease', engine.controlEpoch);

  await assert.rejects(engine.runAgent('invalid_prompt_role', null), /Unknown role: invalid_prompt_role/u);
  assert.equal(providerCalls, 0);
  const attempt = engine.store.db.prepare('SELECT * FROM attempts').get();
  assert.equal(attempt.role, 'invalid_prompt_role');
  assert.equal(attempt.state, 'failed');
  assert.match(attempt.ended, /^\d{4}-\d{2}-\d{2}T/u);
  const failed = engine.store.events(0, 1000).find(event => event.type === 'agent.failed');
  assert.equal(failed.attempt, attempt.id);
  assert.equal(failed.role, 'invalid_prompt_role');
  assert.match(failed.reason, /Unknown role: invalid_prompt_role/u);
});

test('a v2 run resumes its interrupted worker and migrates completion metadata without rewriting the manifest', async t => {
  const env = fixture(t);
  const manifestPath = path.join(env.run, 'run.json');
  const manifest = JSON.parse(readText(manifestPath));
  manifest.version = 2;
  writeJSON(manifestPath, manifest);
  writeJSON(path.join(env.run, 'plan.json'), { summary: 'Legacy saved plan', tasks: [{ ...task(), depends_on: [] }] });
  const store = new Store(env.run);
  const id = store.addTask(task()); store.setMeta('planned', true);
  store.db.prepare("DELETE FROM meta WHERE key IN ('goal:format_version','goal:outcome','run:termination','report:status','goal:contract')").run();
  store.setMeta('goal:assessment', { decision: 'complete', reason: 'Legacy unverified completion assessment.' });
  store.updateTask(id, { state: 'running' });
  const attempt = store.beginAttempt(id, 'worker', 'codex'); store.session(attempt, 'old-worker-session');
  store.close();
  let resumed;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') { resumed = message.request.sessionID; return workerResult(env.workspace); }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(resumed, 'old-worker-session');
  assert.equal(engine.store.tasks().length, 1);
  assert.equal(engine.manifest.version, 2);
  assert.equal(JSON.parse(readText(manifestPath)).version, 2);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(engine.store.getMeta('goal:format_version'), 1);
});

test('stop preserves progress, and resume reuses an interrupted session', async t => {
  const env = fixture(t);
  let workerStarted = false;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'worker') {
      workerStarted = true;
      return await new Promise((resolve, reject) => message.request.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
    }
    return defaultResult(message);
  }) });
  const running = engine.run();
  while (!workerStarted) await sleep(10);
  engine.stop();
  assert.equal(await running, 'stopped');
  assert.equal(engine.store.task(1).state, 'queued');
  engine.close();
  let sessionID;
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') { sessionID = message.request.sessionID; return workerResult(env.workspace); }
    return defaultResult(message);
  }) }); env.dispose(() => resumed.close());
  assert.equal(await resumed.run(), 'completed');
  assert.equal(sessionID, 'fixture-worker');
});

test('live instructions are delivered to an active role and persisted for later roles', async t => {
  const env = fixture(t);
  let started = false, delivered = false, reviewerSawInstruction = false;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'steer') { delivered = message.text.includes('새 지시'); return 'accepted'; }
    if (message.role === 'worker') {
      started = true;
      await sleep(150);
      return workerResult(env.workspace);
    }
    if (message.role === 'supervisor') reviewerSawInstruction = message.data.user_instructions.some(instruction => instruction.text === '새 지시');
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const running = engine.run();
  while (!started) await sleep(10);
  engine.store.message('새 지시');
  await engine.poll();
  assert.equal(await running, 'completed');
  assert.equal(delivered, true);
  assert.equal(reviewerSawInstruction, true);
});

test('a second controller is refused without touching the original run', t => {
  const env = fixture(t);
  const release = acquireLock(env.run); env.dispose(release);
  assert.throws(() => new Engine(env.run), /이미 실행 중/u);
});

test('tampered editor references cannot appear in the final report', async t => {
  const env = fixture(t);
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'editor') return { title: 'Unsupported', body: 'Invented result', fact_ids: [999] };
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  await engine.run();
  const report = readText(path.join(env.run, 'report.md'));
  assert(!report.includes('Invented result'));
  assert(report.includes('최종 편집 세션이 실패'));
});

test('report write failure preserves the committed goal outcome and replaces stale result state', async t => {
  const env = fixture(t);
  let editorCalls = 0;
  writeJSON(path.join(env.run, 'result.json'), { format_version: 2, report: { state: 'complete', id: 'stale' } });
  fs.mkdirSync(path.join(env.run, 'report.md'));
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'editor') editorCalls++;
    return defaultResult(message);
  }) });
  let attempts;
  try {
    assert.equal(await engine.run(), 'completed');
    const completion = engine.store.completionStatus();
    assert.equal(completion.goal_outcome, 'achieved');
    assert.equal(completion.termination.reason, 'goal_achieved');
    assert.equal(completion.report.state, 'failed');
    const result = readJSON(path.join(env.run, 'result.json'));
    assert.equal(result.format_version, 5);
    assert.equal(result.goal_format_version, 1);
    assert.equal(result.goal_outcome, 'achieved');
    assert.equal(result.report.state, 'failed');
    assert.notEqual(result.report.id, 'stale');
    attempts = engine.store.attemptCount({ includeEditor: false });
  } finally { engine.close(); }

  fs.rmSync(path.join(env.run, 'report.md'), { recursive: true });
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') throw new Error('report recovery must not repeat work');
    if (message.role === 'editor') editorCalls++;
    return defaultResult(message);
  }) });
  try {
    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(resumed.store.completionStatus().report.state, 'complete');
    assert.equal(resumed.store.attemptCount({ includeEditor: false }), attempts);
    assert.equal(editorCalls, 1);
  } finally { resumed.close(); }
});

test('a read-only stale result file is repaired before publishing the current outcome', async t => {
  const env = fixture(t);
  const resultPath = path.join(env.run, 'result.json');
  writeJSON(resultPath, { format_version: 2, goal_outcome: 'achieved', report: { state: 'complete', id: 'stale' } });
  fs.chmodSync(resultPath, 0o444);
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) });
  try {
    assert.equal(await engine.run(), 'completed');
    const completion = engine.store.completionStatus();
    const result = readJSON(resultPath);
    assert.equal(completion.goal_outcome, 'achieved');
    assert.equal(completion.report.state, 'complete');
    assert.equal(result.format_version, 5);
    assert.equal(result.goal_outcome, 'achieved');
    assert.equal(result.report.state, 'complete');
    assert.notEqual(result.report.id, 'stale');
  } finally {
    if (fs.existsSync(resultPath)) fs.chmodSync(resultPath, 0o600);
    engine.close();
  }
});

test('stopping report-only recovery preserves achievement and leaves a resumable stale report', async t => {
  const env = fixture(t);
  const first = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) });
  try { assert.equal(await first.run(), 'completed'); }
  finally { first.close(); }

  fs.rmSync(path.join(env.run, 'report.md'));
  const store = new Store(env.run);
  try {
    const config = store.getMeta('config');
    store.setMeta('config', { ...config, roleSettings: { ...config.roleSettings, editor: { effort: 'high' } } });
  } finally { store.close(); }

  let editorStarted = false;
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'editor') {
      editorStarted = true;
      return await new Promise((resolve, reject) => message.request.signal.addEventListener('abort', () => reject(new Error('editor aborted')), { once: true }));
    }
    if (message.role === 'worker') throw new Error('report recovery must not repeat work');
    return defaultResult(message);
  }) });
  try {
    const running = resumed.run();
    while (!editorStarted) await sleep(10);
    resumed.stop();
    assert.equal(await running, 'stopped');
    assert.equal(resumed.store.getMeta('state'), 'completed');
    assert.equal(resumed.store.getMeta('control'), 'stopped');
    assert.equal(resumed.store.getMeta('goal:outcome'), 'achieved');
    assert.equal(resumed.store.getMeta('run:termination').reason, 'goal_achieved');
    assert.equal(resumed.store.getMeta('report:status').state, 'stale');
    assert(resumed.store.getMeta('goal:pending_terminal'));
  } finally { resumed.close(); }
});

test('long Unicode goals are stored losslessly and a changed revision is recorded without stopping', async t => {
  const env = fixture(t);
  const goal = '긴 프롬프트\n"인용"과 $(), `문자`\n'.repeat(4000);
  const directory = createRun({ workspace: env.workspace }, goal, path.join(env.root, 'long-runs'));
  assert.equal(readText(path.join(directory, 'prompt.txt')), goal);
  const manifestPath = path.join(directory, 'run.json');
  const manifest = JSON.parse(readText(manifestPath)); manifest.source.revision = 'different'; writeJSON(manifestPath, manifest);
  const engine = new Engine(directory, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert(engine.store.events().some(event => event.type === 'workspace.external_change'));
});

test('needs_input keeps the controller alive and resumes on a user instruction', async t => {
  const env = fixture(t, { inputPolicy: 'wait' });
  let reviews = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal' && reviews++ === 0) return {
      decision: 'needs_input', contract_revision: message.data.contract.revision,
      requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'unknown', fact_ids: message.data.facts.map(fact => fact.id), reason: 'The external account choice is still unknown.' })),
      reason: 'An external choice is strictly required.', progress: 'Implementation is otherwise verified.',
      next_tasks: [], question: 'Choose the external deployment account.',
    };
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const running = engine.run();
  while (engine.store.getMeta('state') !== 'waiting_input') await sleep(10);
  engine.store.message('Use the local test account.');
  assert.equal(await running, 'completed');
  assert.equal(reviews, 2);
});

test('a waiting Goal wakes when inputPolicy changes to continue', async t => {
  const env = fixture(t, { inputPolicy: 'wait' });
  let goalCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal' && ++goalCalls === 1) return {
      decision: 'needs_input', contract_revision: message.data.contract.revision,
      requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'unknown', fact_ids: message.data.facts.map(fact => fact.id), reason: 'The optional presentation choice is unresolved.' })),
      reason: 'Wait while the run uses the interactive input policy.', progress: 'The implementation evidence is already available.',
      next_tasks: [], question: 'Choose the presentation style.',
    };
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const running = engine.run();
  while (engine.store.getMeta('state') !== 'waiting_input') await sleep(10);
  const config = engine.store.getMeta('config');
  engine.store.setMeta('config', { ...config, inputPolicy: 'continue' });
  const failSafe = setTimeout(() => engine.stop(), 3000);
  try { assert.equal(await running, 'completed'); }
  finally { clearTimeout(failSafe); }
  assert.equal(goalCalls, 2);
  assert.equal(engine.config.inputPolicy, 'continue');
  assert(engine.store.events(0, 1000).some(event => event.type === 'goal.resumed'));
});

test('continuous input policy bypasses reversible questions and keeps doing substantive work', async t => {
  const env = fixture(t);
  let reviews = 0, workers = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') { workers++; return workerResult(env.workspace); }
    if (message.role === 'goal') {
      reviews++;
      assert.match(message.request.prompt, /This run is autonomous/u);
      if (reviews === 1) return {
        decision: 'needs_input', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: message.data.facts.map(fact => fact.id), reason: 'The reversible scope choice is unresolved.' })),
        reason: 'The user has not approved one of two review scopes.', progress: 'Candidate scopes are known.',
        next_tasks: [], question: 'Choose scope A or B.',
      };
      if (reviews === 2) {
        assert.match(message.data.context.controller_feedback, /무인 연속 실행 정책/u);
        return {
          decision: 'continue', contract_revision: message.data.contract.revision,
          requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
            verdict: 'unknown', fact_ids: message.data.facts.map(fact => fact.id), reason: 'The bounded review still needs to run.' })),
          reason: 'Use the bounded recommended scope without waiting.', progress: 'The reversible choice was recorded as an assumption.',
          next_tasks: [{ title: 'Review bounded scope A', brief: 'Perform the substantive review using the recommended bounded scope.', scope: 'docs.runtime.bounded_review', depends_on: [] }], question: '',
        };
      }
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(workers, 2);
  assert.equal(reviews, 3);
  assert.equal(engine.store.tasks().length, 2);
  assert(engine.store.events(0, 500).some(event => event.type === 'goal.input_bypassed'));
  assert.notEqual(engine.store.getMeta('state'), 'waiting_input');
});

test('new runs default to unrestricted provider permissions', t => {
  const env = fixture(t);
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  assert.equal(engine.config.permissions, 'yolo');
  assert.equal(engine.config.inputPolicy, 'continue');
});

test('goal-cycle tasks preserve dependency order without a lifetime task cap', t => {
  const env = fixture(t, { maxTasks: 2 });
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  const scheduled = engine.queueGoalTasks([
    { title: 'Implement', brief: 'Change the implementation.', scope: 'app.implementation', depends_on: [] },
    { title: 'Validate', brief: 'Run the focused validation.', scope: 'app.validation', depends_on: [0] },
  ], 1, 'Continue toward the goal.');
  assert.deepEqual(scheduled, [1, 2]);
  assert.deepEqual(engine.store.task(1).dependencies, []);
  assert.deepEqual(engine.store.task(2).dependencies, [1]);
  assert.deepEqual(engine.queueGoalTasks([
    { title: 'Polish', brief: 'Finish the remaining cleanup.', scope: 'app.cleanup', depends_on: [] },
  ], 2, 'Continue toward the goal.'), [3]);
  assert.equal(engine.store.tasks().length, 3);
});

test('an independent rejection rolls into another Goal segment before achievement', async t => {
  const env = fixture(t, { maxGoalRounds: 1 });
  let goalCalls = 0, reviewCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal') goalCalls++;
    if (message.role === 'goal_review' && ++reviewCalls === 1) return {
      decision: 'reject', contract_revision: message.data.contract.revision,
      reason: 'The first candidate needs another independent assessment.',
      requirement_reviews: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'reject', reason: 'Reject the first candidate only.' })),
    };
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  const completion = engine.store.completionStatus();
  assert.equal(completion.execution_state, 'completed');
  assert.equal(completion.goal_outcome, 'achieved');
  assert.equal(completion.termination.reason, 'goal_achieved');
  assert.equal(completion.report.state, 'complete');
  assert.equal(goalCalls, 2);
  assert.equal(reviewCalls, 2);
  assert(engine.store.tasks().every(item => item.state === 'accepted'));
  assert(engine.store.events(0, 1000).some(event => event.type === 'run.segment_advanced' && event.reason === 'goal_round_limit'));
  assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.suspended'), false);
});

test('no progress triggers a different scoped replan and continues to achievement', async t => {
  const env = fixture(t, { maxNoProgress: 1, maxGoalRounds: 10, maxRevisions: 0 });
  let workers = 0, goalCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') {
      workers++;
      if (message.data.task.scope === 'docs.runtime.alternative') {
        return workerResult(env.workspace, 'The alternative check establishes the requested runtime.', 'docs.runtime.alternative.node');
      }
      return workerResult(env.workspace, 'The repeated check remains inconclusive.', 'docs.runtime.repeated');
    }
    if (message.role === 'supervisor' && message.data.task.scope !== 'docs.runtime.alternative') {
      return verdict(message.data.facts.map(fact => fact.id), 'unresolved', 'reject');
    }
    if (message.role === 'goal') {
      goalCalls++;
      if (goalCalls <= 2) return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The repeated approach has not established this requirement.' })),
        reason: 'Retry the same bounded check.', progress: 'No requirement gained relevant evidence.',
        next_tasks: [{ title: 'Repeated check', brief: 'Repeat the inconclusive check.', scope: 'docs.runtime.repeat', depends_on: [] }], question: '',
      };
      if (goalCalls === 3) {
        assert.match(message.data.context.controller_feedback, /./u);
        return {
          decision: 'continue', contract_revision: message.data.contract.revision,
          requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
            verdict: 'unknown', fact_ids: [], reason: 'A different evidence path is now required.' })),
          reason: 'Use a different scoped check.', progress: 'The repeated path was abandoned.',
          next_tasks: [{ title: 'Alternative runtime check', brief: 'Use a distinct verification path.', scope: 'docs.runtime.alternative', depends_on: [] }], question: '',
        };
      }
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  const completion = engine.store.completionStatus();
  assert.equal(workers, 3);
  assert.equal(goalCalls, 4);
  assert.equal(completion.goal_outcome, 'achieved');
  assert.equal(completion.termination.reason, 'goal_achieved');
  assert.equal(engine.store.tasks().some(item => item.scope === 'docs.runtime.alternative' && item.state === 'accepted'), true);
  assert(engine.store.events(0, 1000).some(event => event.type === 'run.segment_advanced' && event.reason === 'no_progress'));
});

test('unique task titles cannot mask requirement-level no progress before a successful replan', async t => {
  const env = fixture(t, { maxNoProgress: 1, maxGoalRounds: 50, maxRevisions: 0, workers: 1 });
  let engine, goalCalls = 0, replanned = false, finalEvidence = false;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') {
      if (message.data.task.scope === 'docs.runtime.strategy.final') {
        finalEvidence = true;
        return workerResult(env.workspace, 'The distinct strategy establishes the requested runtime.', 'docs.runtime.strategy.final');
      }
      return workerResult(env.workspace, 'The changing task title still yields no requirement evidence.', 'docs.runtime.strategy.stagnant');
    }
    if (message.role === 'supervisor' && message.data.task.scope !== 'docs.runtime.strategy.final') {
      return verdict(message.data.facts.map(fact => fact.id), 'unresolved', 'reject');
    }
    if (message.role === 'goal') {
      goalCalls++;
      if (replanned && finalEvidence) return defaultResult(message);
      if (replanned) return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The new strategy has not run yet.' })),
        reason: 'Run a materially different strategy.', progress: 'The controller detected requirement-level stagnation.',
        next_tasks: [{ title: 'Distinct strategy', brief: 'Use a different evidence path.', scope: 'docs.runtime.strategy.final', depends_on: [] }], question: '',
      };
      if (goalCalls >= 4) engine.stop();
      return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'No requirement verdict or cited fact changed.' })),
        reason: 'Try another nominally different task.', progress: 'The requirement evidence is unchanged.',
        next_tasks: [{ title: `Unique title ${goalCalls}`, brief: `Repeat the same ineffective method ${goalCalls}.`, scope: `docs.runtime.strategy.unique.${goalCalls}`, depends_on: [] }], question: '',
      };
    }
    return defaultResult(message);
  });
  engine = new Engine(env.run, {
    providerFactory: factory,
    onEvent: event => { if (event.type === 'goal.strategy_replanned') replanned = true; },
  });
  env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(replanned, true);
  assert.equal(finalEvidence, true);
  assert.equal(engine.store.tasks().some(item => item.scope === 'docs.runtime.strategy.final' && item.state === 'accepted'), true);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert(engine.store.events(0, 1000).some(event => event.type === 'goal.strategy_replanned'));
});

test('repeated rejection of the same achievement candidate forces a different strategy before achievement', async t => {
  const env = fixture(t, { maxNoProgress: 1, maxGoalRounds: 20, maxRevisions: 0, workers: 1 });
  let engine, replanned = false, recoveryEvidence = false, reviewCalls = 0;
  const rejectedEvaluations = [];
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') {
      if (message.data.task.scope === 'docs.runtime.review_recovery') {
        recoveryEvidence = true;
        return workerResult(env.workspace, 'The independent recovery check establishes the requested runtime.', 'docs.runtime.review_recovery');
      }
      return workerResult(env.workspace);
    }
    if (message.role === 'goal') {
      if (replanned && !recoveryEvidence) return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The rejected candidate needs an independent evidence path.' })),
        reason: 'Run a materially different verification after repeated rejection.', progress: 'The rejected strategy was abandoned.',
        next_tasks: [{ title: 'Independent recovery check', brief: 'Verify the result through a different evidence path.', scope: 'docs.runtime.review_recovery', depends_on: [] }], question: '',
      };
      return defaultResult(message);
    }
    if (message.role === 'goal_review') {
      reviewCalls++;
      if (!replanned) {
        rejectedEvaluations.push(message.data.proposal.requirement_evaluations);
        if (reviewCalls >= 4) engine.stop();
        return {
          decision: 'reject', contract_revision: message.data.contract.revision,
          reason: 'The same achievement candidate still lacks an independent recovery check.',
          requirement_reviews: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
            verdict: 'reject', reason: 'Reject the unchanged candidate.' })),
        };
      }
    }
    return defaultResult(message);
  });
  engine = new Engine(env.run, {
    providerFactory: factory,
    onEvent: event => { if (event.type === 'goal.strategy_replanned') replanned = true; },
  });
  env.dispose(() => engine.close());

  assert.equal(await engine.run(), 'completed');
  assert.equal(replanned, true);
  assert.equal(recoveryEvidence, true);
  assert.equal(reviewCalls, 3);
  assert.equal(rejectedEvaluations.length, 2);
  assert.deepEqual(rejectedEvaluations[1], rejectedEvaluations[0]);
  assert.equal(engine.store.tasks().some(item => item.scope === 'docs.runtime.review_recovery' && item.state === 'accepted'), true);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert(engine.store.events(0, 1000).some(event => event.type === 'goal.strategy_replanned'));
});

test('no-progress replans bound excluded task ids and report exact coverage', t => {
  const env = fixture(t);
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  const excluded = [];
  for (let index = 1; index <= 70; index++) {
    const id = engine.store.addTask({
      title: `Exhausted approach ${index}`,
      brief: `Previously attempted approach ${index}.`,
      scope: `docs.runtime.exhausted.${index}`,
    });
    engine.store.updateTask(id, { state: 'rejected', feedback: 'This approach did not establish the requirement.' });
    excluded.push(id);
  }

  engine.beginSegment('no_progress', { assessment: null, assessmentStatus: 'assessment_not_run', candidate: null });
  const replan = engine.store.getMeta('goal:replan');
  assert.deepEqual(replan.excluded_task_ids, excluded.slice(-64));
  assert.deepEqual(replan.excluded_task_coverage, { total: 70, included: 64, truncated: true });
  const event = engine.store.events(0, 1000).find(item => item.type === 'goal.strategy_replanned');
  assert(event);
  assert.deepEqual(event.excluded_tasks, excluded.slice(-64));
  assert.deepEqual(event.excluded_task_coverage, { total: 70, included: 64, truncated: true });
});

test('repeated autonomous needs_input rolls over and accepts a later achieved assessment', async t => {
  const env = fixture(t, { maxNoProgress: 1, maxGoalRounds: 10 });
  let reviews = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal') {
      reviews++;
      if (reviews > 2) return defaultResult(message);
      return {
        decision: 'needs_input', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: message.data.facts.map(fact => fact.id), reason: 'The same reversible preference remains undecided.' })),
        reason: 'Ask for the same reversible preference.', progress: 'No requirement state changed.',
        next_tasks: [], question: 'Choose presentation A or B.',
      };
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(reviews, 3);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(engine.store.completionStatus().termination.reason, 'goal_achieved');
  assert(engine.store.events(0, 1000).some(event => event.type === 'run.segment_advanced' && event.reason === 'no_progress'));
});

test('maxGoalRounds=1 still detects repeated autonomous needs_input as no progress', async t => {
  const env = fixture(t, { inputPolicy: 'continue', maxGoalRounds: 1, maxNoProgress: 1 });
  let goalCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal' && ++goalCalls <= 2) return {
      decision: 'needs_input', contract_revision: message.data.contract.revision,
      requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'unknown', fact_ids: message.data.facts.map(fact => fact.id), reason: 'The same reversible preference remains undecided.' })),
      reason: 'Ask for the same reversible preference.', progress: 'No requirement evidence changed.',
      next_tasks: [], question: 'Choose presentation A or B.',
    };
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());

  assert.equal(await engine.run(), 'completed');
  assert.equal(goalCalls, 3);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  const events = engine.store.events(0, 1000);
  assert(events.some(event => event.type === 'run.segment_advanced' && event.reason === 'goal_round_limit'));
  assert(events.some(event => event.type === 'run.segment_advanced' && event.reason === 'no_progress'));
  assert(events.some(event => event.type === 'goal.strategy_replanned'));
});

test('a maxAttempts=3 run rolls over multiple segments and reaches a worker and achievement', async t => {
  const env = fixture(t, { maxAttempts: 3, workers: 1 });
  const roles = []; let editorCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    roles.push(message.role);
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal' && message.data.facts.length === 0) return {
      decision: 'needs_input', contract_revision: message.data.contract.revision,
      requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'unknown', fact_ids: [], reason: 'The planned worker has not run in this segment yet.' })),
      reason: 'Evidence collection must continue.', progress: 'The initial controller segment is complete.',
      next_tasks: [], question: 'Continue with the already planned local check?',
    };
    if (message.role === 'editor') editorCalls++;
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  const completion = engine.store.completionStatus();
  assert.equal(completion.execution_state, 'completed');
  assert.equal(completion.goal_outcome, 'achieved');
  assert.equal(completion.termination.reason, 'goal_achieved');
  assert.deepEqual(roles.slice(0, 3), ['contract', 'contract_review', 'planner']);
  assert(roles.includes('worker'));
  assert(roles.includes('goal'));
  assert.equal(editorCalls, 1);
  assert(engine.store.getMeta('run:segment') > 1);
  assert.equal(engine.store.tasks().length, 1);
  assert(engine.store.events(0, 1000).some(event => event.type === 'run.segment_advanced' && event.reason === 'segment_budget_exhausted'));
  assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.suspended'), false);
});

test('a global instruction at an attempt boundary checkpoints stale contract context and continues', async t => {
  const env = fixture(t, { maxAttempts: 3, workers: 1 });
  const instruction = 'Also preserve the newly requested boundary behavior.';
  let engine, instructionID = null, workerSawInstruction = false, contextCheckpoint = null;
  const factory = scriptedFactory(message => {
    if (message.role === 'contract' && message.data.user_instructions.some(item => item.text === instruction)) {
      const result = defaultResult(message);
      result.requirements.push({
        type: 'constraint', statement: 'Preserve the newly requested boundary behavior.',
        source_reference: instruction, verification: 'Verify the added boundary behavior against current evidence.',
      });
      return result;
    }
    if (message.role === 'worker') {
      workerSawInstruction = message.data.user_instructions.some(item => item.text === instruction);
      return workerResult(env.workspace);
    }
    return defaultResult(message);
  });
  engine = new Engine(env.run, {
    providerFactory: factory,
    onEvent: event => {
      if (event.type === 'plan.created' && instructionID === null) instructionID = engine.store.message(instruction);
      if (event.type === 'run.segment_advanced' && event.reason === 'context_changed') {
        contextCheckpoint = engine.store.getMeta('run:last_checkpoint');
      }
    },
  }); env.dispose(() => engine.close());

  assert.equal(await engine.run(), 'completed');
  assert(Number.isSafeInteger(instructionID));
  assert.equal(workerSawInstruction, true);
  assert.equal(engine.store.getMeta('goal:contract').revision, 2);
  assert.equal(engine.store.getMeta('goal:contract').source.message_cutoff, instructionID);
  assert(engine.store.getMeta('goal:contract').requirements.some(item => item.source_reference === instruction));
  assert.equal(engine.store.getMeta('goal:assessment').contract_revision, 2);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(contextCheckpoint.reason, 'context_changed');
  assert.equal(contextCheckpoint.assessment_status, 'context_changed');
  assert.equal(contextCheckpoint.assessment, null);
  assert.equal(contextCheckpoint.candidate, null);
  const events = engine.store.events(0, 1000);
  assert(events.some(event => event.type === 'goal.checkpoint_context_changed' && event.boundary === 'segment_budget_exhausted'));
  assert(events.some(event => event.type === 'run.segment_advanced' && event.reason === 'context_changed'));
});

test('a task queued immediately before assessGoal runs before achievement can commit', async t => {
  const env = fixture(t, { workers: 1 });
  let workers = 0, goalCalls = 0, queuedTask = null;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') {
      workers++;
      return workerResult(env.workspace, `Runtime evidence from task ${message.data.task.id}.`, `docs.runtime.pre_goal.${message.data.task.id}`);
    }
    if (message.role === 'goal') goalCalls++;
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const assessGoal = engine.assessGoal.bind(engine);
  engine.assessGoal = async () => {
    if (queuedTask === null) queuedTask = engine.store.addTask({
      title: 'Late pre-Goal verification',
      brief: 'Run work queued after the controller readiness check but before Goal assessment.',
      scope: 'docs.runtime.pre_goal.late',
    });
    return await assessGoal();
  };

  assert.equal(await engine.run(), 'completed');
  assert(Number.isSafeInteger(queuedTask));
  assert.equal(engine.store.task(queuedTask).state, 'accepted');
  assert.equal(workers, 2);
  assert.equal(goalCalls, 2);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
});

test('targeted instructions racing worker or supervisor returns requeue the task and discard stale results', async t => {
  const scenarios = [
    { name: 'numeric target during worker return', phase: 'worker', target: 1 },
    { name: 'string target during worker return', phase: 'worker', target: '1' },
    { name: 'numeric target during supervisor return', phase: 'supervisor', target: 1 },
    { name: 'string target during supervisor return', phase: 'supervisor', target: '1' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const env = fixture(t, { workers: 1 });
    const instruction = `Apply the ${scenario.name} instruction before accepting T1.`;
    let engine, injected = false, messageID = null, workers = 0, supervisors = 0;
    const workerInstructions = [];
    const supervisorInstructions = [];
    const injectInstruction = () => {
      injected = true;
      const external = new Store(env.run);
      try { messageID = external.message(instruction, scenario.target); }
      finally { external.close(); }
    };
    engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      if (message.role === 'worker') {
        workers++;
        workerInstructions.push(message.data.user_instructions.map(item => item.text));
        if (scenario.phase === 'worker' && !injected) {
          injectInstruction();
        }
        return workerResult(env.workspace, `Runtime evidence from worker generation ${workers}.`, 'docs.runtime.targeted_race');
      }
      if (message.role === 'supervisor') {
        supervisors++;
        supervisorInstructions.push(message.data.user_instructions.map(item => item.text));
        if (scenario.phase === 'supervisor' && !injected) {
          injectInstruction();
        }
      }
      return defaultResult(message);
    }) }); env.dispose(() => engine.close());

    assert.equal(await engine.run(), 'completed');
    assert.equal(injected, true);
    assert(Number.isSafeInteger(messageID));
    assert.equal(workers, 2);
    assert.equal(supervisors, scenario.phase === 'worker' ? 1 : 2);
    assert.deepEqual(workerInstructions.map(items => items.includes(instruction)), [false, true]);
    assert.equal(supervisorInstructions.at(-1).includes(instruction), true);
    const storedMessage = engine.store.db.prepare('SELECT * FROM messages WHERE id=?').get(messageID);
    assert.equal(storedMessage.target, '1');
    assert.equal(engine.store.messages(1).find(message => message.id === messageID)?.text, instruction);
    assert.equal(engine.store.messages('1').find(message => message.id === messageID)?.text, instruction);
    const deliveries = engine.store.db.prepare(`SELECT d.state,a.role,a.task_id FROM deliveries d
      JOIN attempts a ON a.id=d.attempt_id WHERE d.message_id=? ORDER BY a.id`).all(messageID);
    assert(deliveries.some(delivery => delivery.role === 'worker' && delivery.task_id === 1 && delivery.state === 'included'));
    assert(deliveries.some(delivery => delivery.role === 'supervisor' && delivery.task_id === 1 && delivery.state === 'included'));
    assert.equal(engine.store.task(1).state, 'accepted');
    assert(engine.store.task(1).result);
    const facts = engine.store.listFacts({ limit: 500 });
    const stale = facts.find(fact => fact.claim === 'Runtime evidence from worker generation 1.');
    const fresh = facts.find(fact => fact.claim === 'Runtime evidence from worker generation 2.');
    assert(fresh);
    assert.equal(fresh.state, 'verified');
    assert.deepEqual(engine.store.task(1).result.fact_ids, [fresh.id]);
    if (scenario.phase === 'worker') assert.equal(stale, undefined);
    else {
      assert(stale);
      assert.equal(stale.state, 'proposed');
    }
    assert.equal(engine.store.tasks().some(task => ['queued', 'reviewing', 'running'].includes(task.state)), false);
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
    const events = engine.store.events(0, 1000);
    assert(events.some(event => event.type === (scenario.phase === 'worker' ? 'task.submission_discarded' : 'facts.review_discarded')));
  });
});

test('stale provider errors after targeted requeue do not consume failures or strand the instruction', async t => {
  const scenarios = [
    { name: 'worker rejection', phase: 'worker', target: 1 },
    { name: 'supervisor rejection', phase: 'supervisor', target: '1' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const env = fixture(t, { workers: 1, maxFailures: 1 });
    const instruction = `Apply the instruction that raced the stale ${scenario.phase} rejection.`;
    const rejection = `stale ${scenario.phase} rejection after targeted requeue`;
    let engine, injected = false, messageID = null, workers = 0, supervisors = 0;
    const workerInstructions = [];
    const supervisorInstructions = [];
    const injectInstruction = () => {
      injected = true;
      const external = new Store(env.run);
      try { messageID = external.message(instruction, scenario.target); }
      finally { external.close(); }
    };
    engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      if (message.role === 'worker') {
        workers++;
        workerInstructions.push(message.data.user_instructions.map(item => item.text));
        if (scenario.phase === 'worker' && !injected) {
          injectInstruction();
          throw new Error(rejection);
        }
        return workerResult(env.workspace, `Runtime evidence after ${scenario.name}.`, `docs.runtime.targeted_error.${scenario.phase}`);
      }
      if (message.role === 'supervisor') {
        supervisors++;
        supervisorInstructions.push(message.data.user_instructions.map(item => item.text));
        if (scenario.phase === 'supervisor' && !injected) {
          injectInstruction();
          throw new Error(rejection);
        }
      }
      return defaultResult(message);
    }) }); env.dispose(() => engine.close());

    assert.equal(await engine.run(), 'completed');
    assert.equal(injected, true);
    assert(Number.isSafeInteger(messageID));
    assert.equal(workers, 2);
    assert.equal(supervisors, scenario.phase === 'worker' ? 1 : 2);
    assert.deepEqual(workerInstructions.map(items => items.includes(instruction)), [false, true]);
    assert.equal(supervisorInstructions.at(-1).includes(instruction), true);
    const task = engine.store.task(1);
    assert.equal(task.state, 'accepted');
    assert.equal(task.failures, 0);
    assert(task.result);
    const deliveries = engine.store.db.prepare(`SELECT d.state,a.role,a.task_id FROM deliveries d
      JOIN attempts a ON a.id=d.attempt_id WHERE d.message_id=? ORDER BY a.id`).all(messageID);
    assert(deliveries.some(delivery => delivery.role === 'worker' && delivery.task_id === 1 && delivery.state === 'included'));
    assert(deliveries.some(delivery => delivery.role === 'supervisor' && delivery.task_id === 1 && delivery.state === 'included'));
    const discarded = engine.store.events(0, 1000).filter(event => event.type === 'task.attempt_discarded');
    assert(discarded.some(event => event.task === 1 && event.state === 'queued' && event.reason === rejection));
    assert.equal(engine.store.events(0, 1000).some(event => event.type === 'task.state' && event.task === 1 && event.state === 'stalled'), false);
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  });
});

test('a stop immediately after the achievement commit wins without erasing the achievement', async t => {
  const env = fixture(t);
  let engine, stoppedAfterCommit = false;
  engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const commitGoalOutcome = engine.store.commitGoalOutcome.bind(engine.store);
  engine.store.commitGoalOutcome = (candidate, outcome) => {
    const committed = commitGoalOutcome(candidate, outcome);
    if (committed && !stoppedAfterCommit) {
      stoppedAfterCommit = true;
      engine.stop();
    }
    return committed;
  };

  assert.equal(await engine.run(), 'stopped');
  assert.equal(stoppedAfterCommit, true);
  const completion = engine.store.completionStatus();
  assert.equal(completion.execution_state, 'completed');
  assert.equal(completion.goal_outcome, 'achieved');
  assert.equal(completion.termination.reason, 'goal_achieved');
  assert.equal(engine.store.getMeta('control'), 'stopped');
  assert.equal(completion.report.state, 'complete');
  assert(fs.existsSync(completion.report.path));
  assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.finished'), false);
  assert.equal(fs.existsSync(path.join(env.run, 'result.json')), false);
});

test('global instruction and independent work added immediately after achievement commit are processed before completion', async t => {
  const env = fixture(t, { workers: 1 });
  const instruction = 'Also verify the post-commit requirement before finishing.';
  let engine, injected = false, instructionID = null, injectedTask = null;
  const workerScopes = [];
  const factory = scriptedFactory(message => {
    if (message.role === 'contract' && message.data.user_instructions.some(item => item.text === instruction)) {
      const result = defaultResult(message);
      result.requirements.push({
        type: 'constraint', statement: 'Verify the post-commit requirement.', source_reference: instruction,
        verification: 'Confirm the added requirement against current evidence.',
      });
      return result;
    }
    if (message.role === 'worker') {
      workerScopes.push(message.data.task.scope);
      return workerResult(env.workspace, `Runtime evidence from ${message.data.task.scope}.`, `docs.runtime.post_commit.${message.data.task.id}`);
    }
    return defaultResult(message);
  });
  engine = new Engine(env.run, { providerFactory: factory }); env.dispose(() => engine.close());
  const commitGoalOutcome = engine.store.commitGoalOutcome.bind(engine.store);
  engine.store.commitGoalOutcome = (candidate, outcome) => {
    const committed = commitGoalOutcome(candidate, outcome);
    if (committed && !injected) {
      injected = true;
      instructionID = engine.store.message(instruction);
      injectedTask = engine.store.addTask({
        title: 'Post-commit verification',
        brief: 'Run independent work added after the earlier achievement was committed.',
        scope: 'docs.runtime.post_commit',
      });
    }
    return committed;
  };

  assert.equal(await engine.run(), 'completed');
  assert.equal(injected, true);
  assert(Number.isSafeInteger(instructionID));
  assert(Number.isSafeInteger(injectedTask));
  assert.equal(engine.store.task(injectedTask).state, 'accepted');
  assert(workerScopes.includes('docs.runtime.post_commit'));
  const contract = engine.store.getMeta('goal:contract');
  assert.equal(contract.revision, 2);
  assert.equal(contract.source.message_cutoff, instructionID);
  assert(contract.requirements.some(requirement => requirement.source_reference === instruction));
  assert.equal(engine.store.getMeta('goal:assessment').contract_revision, 2);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(engine.store.events(0, 1000).filter(event => event.type === 'run.finished').length, 1);
});

test('work added immediately after an empty ready snapshot remains runnable', async t => {
  const env = fixture(t, { workers: 1 });
  let engine, armed = false, injectedTask = null;
  const workerScopes = [];
  engine = new Engine(env.run, {
    providerFactory: scriptedFactory(message => {
      if (message.role === 'worker') {
        workerScopes.push(message.data.task.scope);
        return workerResult(env.workspace, `Runtime evidence from ${message.data.task.scope}.`, `docs.runtime.ready_race.${message.data.task.id}`);
      }
      return defaultResult(message);
    }),
    onEvent: event => { if (event.type === 'task.state' && event.task === 1 && event.state === 'accepted') armed = true; },
  }); env.dispose(() => engine.close());
  const readyTasks = engine.store.readyTasks.bind(engine.store);
  engine.store.readyTasks = () => {
    const ready = readyTasks();
    if (armed && injectedTask === null && engine.activeTasks.size === 0 && ready.length === 0) {
      injectedTask = engine.store.addTask({
        title: 'Ready snapshot race verification',
        brief: 'Run work queued just after the scheduler observed an empty ready snapshot.',
        scope: 'docs.runtime.ready_race',
      });
    }
    return ready;
  };

  assert.equal(await engine.run(), 'completed');
  assert(Number.isSafeInteger(injectedTask));
  assert.equal(engine.store.task(injectedTask).state, 'accepted');
  assert(workerScopes.includes('docs.runtime.ready_race'));
  assert.equal(workerScopes.length, 2);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
});

test('changes immediately after the final published-candidate check reopen completion', async t => {
  const scenarios = [
    { name: 'new independent task', kind: 'task' },
    { name: 'new global instruction', kind: 'message' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const env = fixture(t, { workers: 1 });
    const instruction = 'Also establish the instruction added at the final publish boundary.';
    let engine, injected = false, injectedID = null, workers = 0;
    const factory = scriptedFactory(message => {
      if (message.role === 'contract' && message.data.user_instructions.some(item => item.text === instruction)) {
        const result = defaultResult(message);
        result.requirements.push({
          type: 'constraint', statement: 'Establish the final-boundary instruction.', source_reference: instruction,
          verification: 'Confirm the final-boundary instruction against verified evidence.',
        });
        return result;
      }
      if (message.role === 'worker') {
        workers++;
        return workerResult(env.workspace, `Runtime evidence from task ${message.data.task.id}.`, `docs.runtime.final_boundary.${message.data.task.id}`);
      }
      return defaultResult(message);
    });
    engine = new Engine(env.run, { providerFactory: factory }); env.dispose(() => engine.close());
    const finishCompletedRun = engine.store.finishCompletedRun.bind(engine.store);
    engine.store.finishCompletedRun = (candidate, reportID) => {
      if (!injected && engine.store.getMeta('goal:outcome') === 'achieved'
          && fs.existsSync(path.join(env.run, 'result.json'))) {
        injected = true;
        injectedID = scenario.kind === 'task'
          ? engine.store.addTask({
            title: 'Final publish boundary task',
            brief: 'Execute work added after the final published-candidate currentness check.',
            scope: 'docs.runtime.final_boundary',
          })
          : engine.store.message(instruction);
      }
      return finishCompletedRun(candidate, reportID);
    };

    assert.equal(await engine.run(), 'completed');
    assert.equal(injected, true);
    assert(Number.isSafeInteger(injectedID));
    if (scenario.kind === 'task') {
      assert.equal(engine.store.task(injectedID).state, 'accepted');
      assert.equal(workers, 2);
    } else {
      const contract = engine.store.getMeta('goal:contract');
      assert.equal(contract.revision, 2);
      assert.equal(contract.source.message_cutoff, injectedID);
      assert(contract.requirements.some(requirement => requirement.source_reference === instruction));
    }
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(engine.store.events(0, 1000).filter(event => event.type === 'run.finished').length, 1);
  });
});

test('a retry queued immediately after the final published-candidate check reopens completion', async t => {
  const env = fixture(t, { workers: 1 });
  let engine, retried = false, workers = 0;
  engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') {
      workers++;
      return workerResult(env.workspace, `Runtime evidence generation ${workers}.`, `docs.runtime.final_retry.${workers}`);
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const finishCompletedRun = engine.store.finishCompletedRun.bind(engine.store);
  engine.store.finishCompletedRun = (candidate, reportID) => {
    if (!retried && engine.store.getMeta('goal:outcome') === 'achieved'
        && fs.existsSync(path.join(env.run, 'result.json'))) {
      retried = true;
      const task = engine.store.task(1);
      engine.store.updateTask(task.id, {
        state: 'queued', result: null, failures: 0, revisions: 0,
        feedback: 'Explicit retry queued at the final publish boundary.',
      });
    }
    return finishCompletedRun(candidate, reportID);
  };

  assert.equal(await engine.run(), 'completed');
  assert.equal(retried, true);
  assert.equal(workers, 2);
  assert.equal(engine.store.task(1).state, 'accepted');
  assert.equal(engine.store.task(1).failures, 0);
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(engine.store.events(0, 1000).filter(event => event.type === 'run.finished').length, 1);
});

test('external stop racing a provider rejection preserves resumable task and attempt state', async t => {
  const scenarios = [
    { name: 'worker rejection restores queued work', blockedRole: 'worker', expectedState: 'queued' },
    { name: 'review rejection preserves the submitted result', blockedRole: 'supervisor', expectedState: 'reviewing' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const env = fixture(t, { workers: 1 });
    let rejectProvider, blocked = false, initialWorkers = 0;
    const first = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      if (message.role === 'worker') {
        initialWorkers++;
        if (scenario.blockedRole !== 'worker') return workerResult(env.workspace);
      }
      if (message.role === scenario.blockedRole) {
        blocked = true;
        return new Promise((resolve, reject) => { rejectProvider = reject; });
      }
      return defaultResult(message);
    }) });
    const running = first.run();
    while (!blocked) await sleep(10);
    const external = new Store(env.run);
    try { assert.equal(external.commitStopped('external stop raced provider rejection'), true); }
    finally { external.close(); }
    rejectProvider(new Error('provider rejected after external stop'));
    assert.equal(await running, 'stopped');
    const taskAfterStop = first.store.task(1);
    assert.equal(taskAfterStop.state, scenario.expectedState);
    assert.equal(taskAfterStop.failures, 0);
    if (scenario.expectedState === 'reviewing') assert(taskAfterStop.result);
    const interrupted = first.store.db.prepare("SELECT * FROM attempts WHERE role=? ORDER BY id DESC LIMIT 1").get(scenario.blockedRole);
    assert.equal(interrupted.state, 'interrupted');
    assert.match(interrupted.ended, /^\d{4}-\d{2}-\d{2}T/u);
    first.close();

    let resumedWorkerSession = null, resumedWorkers = 0;
    const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      if (message.role === 'worker') {
        resumedWorkers++;
        resumedWorkerSession = message.request.sessionID;
        return workerResult(env.workspace);
      }
      return defaultResult(message);
    }) }); env.dispose(() => resumed.close());
    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.task(1).state, 'accepted');
    assert.equal(resumed.store.task(1).failures, 0);
    assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
    if (scenario.blockedRole === 'worker') {
      assert.equal(resumedWorkers, 1);
      assert.equal(resumedWorkerSession, 'fixture-worker');
    } else {
      assert.equal(initialWorkers, 1);
      assert.equal(resumedWorkers, 0);
    }
  });
});

test('control failures beyond maxControlFailures back off and recover to achievement', async t => {
  const env = fixture(t, { maxControlFailures: 1 });
  let calls = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'contract' && ++calls <= 2) throw new Error('contract provider failed');
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  });
  const engine = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await engine.run(), 'completed');
    assert.equal(calls, 3);
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(engine.store.getMeta('control:failures:contract').count, 0);
    assert.equal(engine.store.events(0, 1000).filter(event => event.type === 'control.retry_scheduled' && event.stage === 'contract').length, 2);
    assert(engine.store.events(0, 1000).filter(event => event.type === 'run.segment_advanced' && event.reason === 'contract_control_failure_window').length >= 2);
  } finally { engine.close(); }
});

test('a new Engine honors a stored contract retry deadline and remains stoppable while waiting', async t => {
  const scenarios = [
    { name: 'waits before provider invocation', stop: false },
    { name: 'responds to stop during the wait', stop: true },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const env = fixture(t);
    const setup = new Engine(env.run);
    const delay = scenario.stop ? 30000 : 600;
    const retryAt = Date.now() + delay;
    try {
      setup.store.setMeta('control:retry:contract', {
        failures: 1, reason: 'stored transient failure', retry_at: new Date(retryAt).toISOString(),
        context_fingerprint: setup.controlFailureContext('contract'), at: new Date().toISOString(),
      });
    } finally { setup.close(); }

    let providerCalls = 0, firstProviderAt = null;
    const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      providerCalls++;
      firstProviderAt ??= Date.now();
      if (message.role === 'worker') return workerResult(env.workspace);
      return defaultResult(message);
    }) }); env.dispose(() => engine.close());
    const running = engine.run();
    if (scenario.stop) {
      while (!engine.store.events(0, 1000).some(event => event.type === 'control.retry_resumed' && event.stage === 'contract')) await sleep(10);
      const stoppedAt = Date.now();
      engine.stop();
      assert.equal(await running, 'stopped');
      assert(Date.now() - stoppedAt < 1500);
      assert.equal(providerCalls, 0);
    } else {
      assert.equal(await running, 'completed');
      assert(Number.isSafeInteger(firstProviderAt));
      assert(firstProviderAt >= retryAt - 20, `provider started ${retryAt - firstProviderAt}ms before retry_at`);
      assert(providerCalls > 0);
    }
  });
});

test('a control failure after an in-flight instruction change starts a fresh context count', t => {
  const env = fixture(t, { maxControlFailures: 2 });
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  engine.store.setMeta('control:failures:contract', { count: 1,
    source_fingerprint: engine.goalSource().fingerprint,
    context_fingerprint: engine.controlFailureContext('contract') });
  engine.store.message('실행 중 추가된 전체 지시입니다.');
  assert.equal(engine.recordControlFailure('contract', new Error('old in-flight attempt failed')), 1);
  assert.equal(engine.store.getMeta('control:failures:contract').count, 1);
});

test('a completed achieved run remains idempotent across a new attempt segment', async t => {
  const env = fixture(t, { maxAttempts: 9 });
  const roles = [];
  const factory = scriptedFactory(message => {
    roles.push(message.role);
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  });
  const first = new Engine(env.run, { providerFactory: factory });
  const reportPath = path.join(env.run, 'report.md');
  const resultPath = path.join(env.run, 'result.json');
  let attempts, completedAt, reportMtime, resultMtime, finishedEvents;
  try {
    assert.equal(await first.run(), 'completed');
    assert.equal(first.store.completionStatus().goal_outcome, 'achieved');
    attempts = first.store.attemptCount();
    assert.equal(attempts, 9);
    completedAt = first.store.getMeta('report:status').completed_at;
    reportMtime = fs.statSync(reportPath).mtimeMs;
    resultMtime = fs.statSync(resultPath).mtimeMs;
    finishedEvents = first.store.events(0, 1000).filter(event => event.type === 'run.finished').length;
    assert.equal(first.store.getMeta('goal:pending_terminal'), null);
  } finally { first.close(); }
  const roleCount = roles.length;
  await sleep(20);

  const resumed = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(resumed.store.completionStatus().termination.reason, 'goal_achieved');
    assert.equal(resumed.store.attemptCount(), attempts);
    assert.equal(roles.length, roleCount);
    assert.equal(resumed.store.getMeta('report:status').completed_at, completedAt);
    assert.equal(fs.statSync(reportPath).mtimeMs, reportMtime);
    assert.equal(fs.statSync(resultPath).mtimeMs, resultMtime);
    assert.equal(resumed.store.events(0, 1000).filter(event => event.type === 'run.finished').length, finishedEvents);
  } finally { resumed.close(); }
});

test('segment exhaustion continues a reviewing task in the same run without consuming failures', async t => {
  const env = fixture(t, { maxAttempts: 4, maxFailures: 1 });
  let workers = 0, reviews = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') { workers++; return workerResult(env.workspace); }
    if (message.role === 'supervisor') reviews++;
    if (message.role === 'goal' && message.data.facts.length === 0) return {
      decision: 'needs_input', contract_revision: message.data.contract.revision,
      requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'unknown', fact_ids: [], reason: 'The pending review must finish before achievement can be assessed.' })),
      reason: 'Finish the pending review.', progress: 'The worker result is stored for the next segment.',
      next_tasks: [], question: 'Continue the pending local review?',
    };
    return defaultResult(message);
  });
  const engine = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await engine.run(), 'completed');
    assert.equal(engine.store.task(1).state, 'accepted');
    assert.equal(engine.store.task(1).failures, 0);
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(workers, 1);
    assert.equal(reviews, 1);
    assert(engine.store.events(0, 1000).some(event => event.type === 'run.segment_advanced' && event.reason === 'segment_budget_exhausted'));
  } finally { engine.close(); }
});

test('maxGoalRounds=1 automatically advances segments until later work achieves the goal', async t => {
  const env = fixture(t, { maxGoalRounds: 1 });
  let goalCalls = 0;
  let workers = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') {
      workers++;
      return workerResult(env.workspace, `Runtime evidence from task ${message.data.task.id}.`, `docs.runtime.goal.${message.data.task.id}`);
    }
    if (message.role === 'goal') {
      goalCalls++;
      if (goalCalls <= 2) return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The requested outcome is not yet established.' })),
        reason: 'More work is required.', progress: `Bounded approach ${goalCalls} is complete.`,
        next_tasks: [{ title: `Another approach ${goalCalls}`, brief: `Try distinct implementation approach ${goalCalls}.`, scope: `docs.runtime.alternative.${goalCalls}`, depends_on: [] }], question: '',
      };
    }
    return defaultResult(message);
  });
  const engine = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await engine.run(), 'completed');
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(engine.store.completionStatus().termination.reason, 'goal_achieved');
    assert.equal(engine.store.getMeta('goal:round'), 3);
    assert.equal(goalCalls, 3);
    assert.equal(workers, 3);
    assert.equal(engine.store.events(0, 1000).filter(event => event.type === 'run.segment_advanced' && event.reason === 'goal_round_limit').length, 2);
    assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.suspended'), false);
  } finally { engine.close(); }
});

test('an external stop after Engine construction wins before run claims control', async t => {
  const env = fixture(t);
  let providerCalls = 0;
  const engine = new Engine(env.run, { providerFactory: () => {
    providerCalls++;
    throw new Error('a pre-claim stop must prevent provider creation');
  } }); env.dispose(() => engine.close());
  const initialEpoch = engine.controlEpoch;
  const external = new Store(env.run);
  try { assert.equal(external.commitStopped('external pre-claim stop'), true); }
  finally { external.close(); }

  assert.equal(await engine.run(), 'stopped');
  assert.equal(providerCalls, 0);
  assert.equal(engine.store.getMeta('control:epoch'), initialEpoch + 1);
  assert.equal(engine.store.getMeta('control'), 'stopped');
  assert.equal(engine.store.getMeta('state'), 'stopped');
  assert.equal(engine.store.getMeta('run:termination').reason, 'user_stopped');
  assert.equal(engine.store.getMeta('run:termination').detail, 'external pre-claim stop');
  assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.started'), false);
});

test('a repeated external stop fences a resume constructed from an already stopped run', async t => {
  const env = fixture(t);
  const firstStop = new Store(env.run);
  try { assert.equal(firstStop.commitStopped('initial explicit stop'), true); }
  finally { firstStop.close(); }

  let providerCalls = 0;
  const engine = new Engine(env.run, { providerFactory: () => {
    providerCalls++;
    throw new Error('the repeated stop must fence the pending resume');
  } }); env.dispose(() => engine.close());
  const capturedEpoch = engine.controlEpoch;
  const repeatedStop = new Store(env.run);
  try { assert.equal(repeatedStop.commitStopped('repeated explicit stop'), true); }
  finally { repeatedStop.close(); }

  assert.equal(await engine.run(), 'stopped');
  assert.equal(providerCalls, 0);
  assert.equal(engine.store.getMeta('control:epoch'), capturedEpoch + 1);
  assert.equal(engine.store.getMeta('control'), 'stopped');
  assert.equal(engine.store.getMeta('state'), 'stopped');
  assert.equal(engine.store.getMeta('run:termination').reason, 'user_stopped');
  assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.started'), false);
});

test('an external pause after Engine construction waits before claiming control', async t => {
  const env = fixture(t);
  let providerCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    providerCalls++;
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const external = new Store(env.run); env.dispose(() => external.close());
  external.requestControl('paused');

  const running = engine.run();
  assert.equal(engine.store.getMeta('control'), 'paused');
  assert.equal(providerCalls, 0);
  assert.equal(await Promise.race([running.then(() => 'settled'), sleep(50).then(() => 'waiting')]), 'waiting');
  assert.equal(providerCalls, 0);

  external.requestControl('running');
  assert.equal(await running, 'completed');
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(engine.store.getMeta('run:termination').reason, 'goal_achieved');
});

test('a duplicate pause after completed-resume construction waits without rerunning the goal', async t => {
  const env = fixture(t);
  const firstFactory = scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  });
  const first = new Engine(env.run, { providerFactory: firstFactory });
  let attempts, reportID;
  try {
    assert.equal(await first.run(), 'completed');
    attempts = first.store.attemptCount();
    reportID = first.store.getMeta('report:status').id;
  } finally { first.close(); }

  let providerCalls = 0;
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    providerCalls++;
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => resumed.close());
  const external = new Store(env.run); env.dispose(() => external.close());
  external.requestControl('paused');

  const running = resumed.run();
  assert.equal(resumed.store.getMeta('control'), 'paused');
  assert.equal(await Promise.race([running.then(() => 'settled'), sleep(50).then(() => 'waiting')]), 'waiting');
  assert.equal(providerCalls, 0);
  assert.equal(resumed.store.attemptCount(), attempts);

  external.requestControl('running');
  assert.equal(await running, 'completed');
  assert.equal(providerCalls, 0);
  assert.equal(resumed.store.attemptCount(), attempts);
  assert.equal(resumed.store.getMeta('report:status').id, reportID);
  assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
});

test('pre-claim work added to a completed run is processed by the pending resume', async t => {
  const scenarios = ['global instruction', 'new task', 'task retry'];
  for (const scenario of scenarios) await t.test(scenario, async t => {
    const env = fixture(t);
    const first = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      if (message.role === 'worker') return workerResult(env.workspace);
      return defaultResult(message);
    }) });
    try { assert.equal(await first.run(), 'completed'); }
    finally { first.close(); }

    let workers = 0, supervisors = 0;
    const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
      if (message.role === 'worker') {
        workers++;
        return workerResult(env.workspace, `Pre-claim evidence for task ${message.data.task.id}.`, `docs.runtime.preclaim.${message.data.task.id}`);
      }
      if (message.role === 'supervisor') supervisors++;
      return defaultResult(message);
    }) }); env.dispose(() => resumed.close());
    const external = new Store(env.run);
    let addedTask = null;
    try {
      if (scenario === 'global instruction') external.message('Include this pre-claim instruction in the resumed goal.');
      else if (scenario === 'new task') addedTask = external.addTask({
        title: 'Pre-claim added task', brief: 'Execute work added after resume construction.', scope: 'docs.runtime.preclaim',
      });
      else external.updateTask(1, { state: 'reviewing', failures: 0, revisions: 0,
        feedback: 'Retry requested after resume construction.' });
      assert.equal(external.getMeta('control'), 'stopped');
      assert.equal(external.getMeta('state'), 'stopped');
    } finally { external.close(); }

    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(resumed.store.getMeta('run:termination').reason, 'goal_achieved');
    if (scenario === 'global instruction') {
      assert(resumed.goalSource().effective_text.includes('pre-claim instruction'));
      assert.equal(resumed.store.getMeta('goal:contract').source.fingerprint, resumed.goalSource().fingerprint);
    } else if (scenario === 'new task') {
      assert.equal(resumed.store.task(addedTask).state, 'accepted');
      assert.equal(workers, 1);
    } else {
      assert.equal(resumed.store.task(1).state, 'accepted');
      assert.equal(workers, 0);
      assert.equal(supervisors, 1);
    }
  });
});

test('a pause after claiming control waits for continue before startup preparation', async t => {
  const env = fixture(t);
  let providerCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    providerCalls++;
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const claimRunning = engine.store.claimRunning.bind(engine.store);
  let pauseInjected = false;
  engine.store.claimRunning = (expectedEpoch, expectedControl, expectedRevision) => {
    const epoch = claimRunning(expectedEpoch, expectedControl, expectedRevision);
    if (epoch !== null && !pauseInjected) {
      pauseInjected = true;
      engine.store.requestControl('paused');
    }
    return epoch;
  };

  const running = engine.run();
  assert.equal(engine.store.getMeta('control'), 'paused');
  assert.equal(providerCalls, 0);
  assert.equal(await Promise.race([running.then(() => 'settled'), sleep(50).then(() => 'waiting')]), 'waiting');
  assert.equal(providerCalls, 0);

  engine.store.requestControl('running');
  assert.equal(await running, 'completed');
  assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(engine.store.getMeta('run:termination').reason, 'goal_achieved');
});

test('a pause at completed-resume publication waits for continue instead of returning', async t => {
  const env = fixture(t);
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  });
  const first = new Engine(env.run, { providerFactory: factory });
  let attempts;
  try {
    assert.equal(await first.run(), 'completed');
    attempts = first.store.attemptCount();
  }
  finally { first.close(); }

  let providerCalls = 0;
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    providerCalls++;
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => resumed.close());
  const completedReportIsCurrent = resumed.completedReportIsCurrent.bind(resumed);
  let pauseInjected = false;
  resumed.completedReportIsCurrent = status => {
    const current = completedReportIsCurrent(status);
    if (current && !pauseInjected) {
      pauseInjected = true;
      resumed.store.requestControl('paused');
    }
    return current;
  };

  const running = resumed.run();
  assert.equal(resumed.store.getMeta('control'), 'paused');
  assert.equal(providerCalls, 0);
  assert.equal(await Promise.race([running.then(() => 'settled'), sleep(50).then(() => 'waiting')]), 'waiting');
  assert.equal(providerCalls, 0);

  resumed.store.requestControl('running');
  assert.equal(await running, 'completed');
  assert.equal(providerCalls, 0);
  assert.equal(resumed.store.attemptCount(), attempts);
  assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
  assert.equal(resumed.store.getMeta('run:termination').reason, 'goal_achieved');
});

test('an explicit stop at a Goal rollover boundary prevents the next segment from starting', async t => {
  const env = fixture(t, { maxGoalRounds: 1 });
  let engine, goalCalls = 0, workers = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') { workers++; return workerResult(env.workspace); }
    if (message.role === 'editor') throw new Error('a stopped rollover must not reach the editor');
    if (message.role === 'goal') {
      goalCalls++;
      return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The next segment would need another approach.' })),
        reason: 'Continue in another segment.', progress: 'One bounded approach was reviewed.',
        next_tasks: [{ title: 'Next stopped approach', brief: 'This task must remain queued after stop.', scope: 'docs.runtime.stopped.next', depends_on: [] }], question: '',
      };
    }
    return defaultResult(message);
  });
  engine = new Engine(env.run, {
    providerFactory: factory,
    onEvent: event => {
      if (event.type === 'run.segment_advanced' && event.reason === 'goal_round_limit') engine.stop();
    },
  });
  try {
    assert.equal(await engine.run(), 'stopped');
    assert.equal(engine.store.getMeta('state'), 'stopped');
    assert.equal(engine.store.getMeta('run:termination').reason, 'user_stopped');
    assert.equal(goalCalls, 1);
    assert.equal(workers, 1);
    assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.finished'), false);
    assert.equal(engine.store.events(0, 1000).some(event => event.type === 'run.suspended'), false);
  } finally { engine.close(); }
});

test('stopping an achieved report still resumes report generation without repeating work', async t => {
  const env = fixture(t);
  let engine, stopEditor = true, workers = 0;
  const firstFactory = scriptedFactory(message => {
    if (message.role === 'worker') { workers++; return workerResult(env.workspace); }
    if (message.role === 'editor' && stopEditor) {
      stopEditor = false;
      engine.stop();
      throw new Error('editor interrupted');
    }
    return defaultResult(message);
  });
  engine = new Engine(env.run, { providerFactory: firstFactory });
  try {
    assert.equal(await engine.run(), 'stopped');
    assert.equal(engine.store.getMeta('goal:round'), 1);
    assert(engine.store.getMeta('goal:pending_terminal'));
  } finally { engine.close(); }

  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') throw new Error('report recovery must not repeat work');
    return defaultResult(message);
  }) });
  try {
    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(resumed.store.getMeta('goal:round'), 1);
    assert.equal(resumed.store.getMeta('goal:pending_terminal'), null);
    assert.equal(workers, 1);
  } finally { resumed.close(); }
});

test('commitStopped atomically records stop metadata and cannot overwrite achievement', t => {
  const env = fixture(t);
  const store = new Store(env.run); env.dispose(() => store.close());
  const runningSegment = { id: 1, phase: 'running', started_at: '2026-01-01T00:00:00.000Z' };
  store.setMeta('control', 'running');
  store.setMeta('state', 'running');
  store.setMeta('run:termination', null);
  store.setMeta('run:segment_state', runningSegment);
  store.setMeta('report:status', { state: 'generating', id: 'draft-report' });
  store.db.exec(`CREATE TEMP TRIGGER fail_stop_transaction BEFORE UPDATE ON meta
    WHEN NEW.key='run:termination' BEGIN SELECT RAISE(ABORT, 'forced stop transaction failure'); END`);
  assert.throws(() => store.commitStopped('must roll back'), /forced stop transaction failure/u);
  assert.equal(store.getMeta('control'), 'running');
  assert.equal(store.getMeta('state'), 'running');
  assert.equal(store.getMeta('run:termination'), null);
  assert.deepEqual(store.getMeta('run:segment_state'), runningSegment);
  assert.deepEqual(store.getMeta('report:status'), { state: 'generating', id: 'draft-report' });
  store.db.exec('DROP TRIGGER fail_stop_transaction');

  assert.equal(store.commitStopped('atomic stop'), true);
  const termination = store.getMeta('run:termination');
  const stoppedSegment = store.getMeta('run:segment_state');
  assert.equal(store.getMeta('control'), 'stopped');
  assert.equal(store.getMeta('state'), 'stopped');
  assert.deepEqual(termination, { reason: 'user_stopped', at: termination.at, detail: 'atomic stop' });
  assert.equal(stoppedSegment.phase, 'stopped');
  assert.equal(stoppedSegment.ended_at, termination.at);
  assert.equal(stoppedSegment.termination_reason, 'user_stopped');
  assert.deepEqual(store.getMeta('report:status'), { state: 'stale', id: 'draft-report', reason: 'user_stopped' });

  const achieved = {
    control: 'running', state: 'completed', outcome: 'achieved',
    termination: { reason: 'goal_achieved', at: '2026-01-02T00:00:00.000Z' },
    segment: { id: 1, phase: 'completed', ended_at: '2026-01-02T00:00:00.000Z', termination_reason: 'goal_achieved' },
    report: { state: 'generating', id: 'final-report' },
  };
  store.setMeta('control', achieved.control);
  store.setMeta('state', achieved.state);
  store.setMeta('goal:outcome', achieved.outcome);
  store.setMeta('run:termination', achieved.termination);
  store.setMeta('run:segment_state', achieved.segment);
  store.setMeta('report:status', achieved.report);
  const achievedEpoch = store.getMeta('control:epoch', 0) || 0;
  assert.equal(store.commitStopped('late stop'), true);
  assert.equal(store.getMeta('control'), 'stopped');
  assert.equal(store.getMeta('control:epoch'), achievedEpoch + 1);
  assert.equal(store.getMeta('state'), achieved.state);
  assert.equal(store.getMeta('goal:outcome'), achieved.outcome);
  assert.deepEqual(store.getMeta('run:termination'), achieved.termination);
  assert.deepEqual(store.getMeta('run:segment_state'), achieved.segment);
  assert.deepEqual(store.getMeta('report:status'), { ...achieved.report, state: 'stale', reason: 'user_stopped' });
  const stoppedEpoch = store.getMeta('control:epoch');
  assert.equal(store.commitStopped('duplicate stop'), true);
  assert.equal(store.getMeta('control:epoch'), stoppedEpoch + 1);
});

test('achievement and completed segment phase are committed atomically', async t => {
  const env = fixture(t);
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');

  const assessment = engine.store.getMeta('goal:assessment');
  const candidate = engine.store.getMeta('goal:candidate');
  const termination = engine.store.getMeta('run:termination');
  const completedSegment = engine.store.getMeta('run:segment_state');
  const runningSegment = { ...completedSegment, phase: 'running' };
  delete runningSegment.ended_at;
  delete runningSegment.termination_reason;
  const pending = { kind: 'achieved', sentinel: true };
  const beforeReport = { state: 'not_started', id: 'before-atomic-commit' };
  const generating = { state: 'generating', id: 'atomic-achievement', contract_revision: assessment.contract_revision,
    assessment_round: assessment.round, generation: 'editor' };
  engine.store.transaction(() => {
    engine.store.setMeta('control', 'running');
    engine.store.setMeta('control:lease', candidate.control_epoch);
    engine.store.setMeta('state', 'running');
    engine.store.setMeta('goal:assessment', null);
    engine.store.setMeta('goal:candidate', null);
    engine.store.setMeta('goal:pending_terminal', pending);
    engine.store.setMeta('goal:outcome', 'pending');
    engine.store.setMeta('run:termination', null);
    engine.store.setMeta('report:status', beforeReport);
    engine.store.setMeta('run:segment_state', runningSegment);
  });
  engine.store.db.exec(`CREATE TEMP TRIGGER fail_achievement_segment BEFORE UPDATE ON meta
    WHEN NEW.key='run:segment_state' BEGIN SELECT RAISE(ABORT, 'forced achieved segment failure'); END`);
  assert.throws(() => engine.store.commitGoalOutcome(candidate, {
    outcome: 'achieved', termination, assessment, report: generating,
  }), /forced achieved segment failure/u);
  assert.equal(engine.store.getMeta('state'), 'running');
  assert.equal(engine.store.getMeta('goal:outcome'), 'pending');
  assert.equal(engine.store.getMeta('goal:assessment'), null);
  assert.equal(engine.store.getMeta('goal:candidate'), null);
  assert.deepEqual(engine.store.getMeta('goal:pending_terminal'), pending);
  assert.equal(engine.store.getMeta('run:termination'), null);
  assert.deepEqual(engine.store.getMeta('report:status'), beforeReport);
  assert.deepEqual(engine.store.getMeta('run:segment_state'), runningSegment);
  engine.store.db.exec('DROP TRIGGER fail_achievement_segment');

  assert.equal(engine.store.commitGoalOutcome(candidate, {
    outcome: 'achieved', termination, assessment, report: generating,
  }), true);
  const committedSegment = engine.store.getMeta('run:segment_state');
  assert.equal(engine.store.getMeta('state'), 'completed');
  assert.equal(engine.store.getMeta('goal:outcome'), 'achieved');
  assert.deepEqual(engine.store.getMeta('goal:assessment'), assessment);
  assert.deepEqual(engine.store.getMeta('goal:candidate'), candidate);
  assert.equal(engine.store.getMeta('goal:pending_terminal'), null);
  assert.deepEqual(engine.store.getMeta('run:termination'), termination);
  assert.deepEqual(engine.store.getMeta('report:status'), generating);
  assert.equal(committedSegment.phase, 'completed');
  assert.equal(committedSegment.ended_at, termination.at);
  assert.equal(committedSegment.termination_reason, 'goal_achieved');
});

test('goal progress is canonical and only advances for newly seen criterion evidence or verdicts', t => {
  const env = fixture(t);
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  const assessment = (round, requirement_evaluations) => ({ round, requirement_evaluations });

  const first = engine.progressState(assessment(1, [
    { requirement_id: 'R2', verdict: 'unknown', fact_ids: [3, 2] },
    { requirement_id: 'R1', verdict: 'unsatisfied', fact_ids: [1] },
  ]));
  assert.equal(first.progressed, true);
  assert.equal(first.stagnant, 0);

  const reordered = engine.progressState(assessment(2, [
    { requirement_id: 'R1', verdict: 'unsatisfied', fact_ids: [1] },
    { requirement_id: 'R2', verdict: 'unknown', fact_ids: [2, 3] },
  ]));
  assert.equal(reordered.signature, first.signature);
  assert.equal(reordered.progressed, false);
  assert.equal(reordered.stagnant, 1);

  const newEvidence = engine.progressState(assessment(3, [
    { requirement_id: 'R1', verdict: 'unsatisfied', fact_ids: [4] },
    { requirement_id: 'R2', verdict: 'unknown', fact_ids: [2] },
  ]));
  assert.equal(newEvidence.progressed, true);
  assert.equal(newEvidence.stagnant, 0);

  const reusedEvidence = engine.progressState(assessment(4, [
    { requirement_id: 'R2', verdict: 'unknown', fact_ids: [3] },
    { requirement_id: 'R1', verdict: 'unsatisfied', fact_ids: [1] },
  ]));
  assert.equal(reusedEvidence.progressed, false);
  assert.equal(reusedEvidence.stagnant, 1);

  const newVerdict = engine.progressState(assessment(5, [
    { requirement_id: 'R1', verdict: 'unknown', fact_ids: [1] },
    { requirement_id: 'R2', verdict: 'unknown', fact_ids: [2] },
  ]));
  assert.equal(newVerdict.progressed, true);
  assert.equal(newVerdict.stagnant, 0);
  assert.deepEqual(engine.store.getMeta('goal:progress').seen, {
    R1: { verdicts: ['unknown', 'unsatisfied'], fact_ids: [1, 4] },
    R2: { verdicts: ['unknown'], fact_ids: [2, 3] },
  });
});
