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
    assert.equal(result.format_version, 3);
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
    assert.equal(result.format_version, 3);
    assert.equal(result.goal_outcome, 'achieved');
    assert.equal(result.report.state, 'complete');
    assert.notEqual(result.report.id, 'stale');
  } finally {
    if (fs.existsSync(resultPath)) fs.chmodSync(resultPath, 0o600);
    engine.close();
  }
});

test('stopping report-only recovery returns a resumable stopped state', async t => {
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
    assert.equal(resumed.store.getMeta('state'), 'stopped');
    assert.equal(resumed.store.getMeta('control'), 'stopped');
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

test('an accepted report and verified activity cannot become achievement after independent rejection', async t => {
  const env = fixture(t, { maxGoalRounds: 1 });
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace, 'The requested result was not established; only the review was completed.');
    if (message.role === 'goal_review') return {
      decision: 'reject', contract_revision: message.data.contract.revision,
      reason: 'The cited fact establishes activity, not the requested outcome.',
      requirement_reviews: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'reject', reason: 'The evidence does not establish this required outcome.' })),
    };
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  const completion = engine.store.completionStatus();
  assert.equal(completion.goal_outcome, 'not_established');
  assert.equal(completion.termination.reason, 'budget_exhausted');
  assert.equal(completion.report.state, 'complete');
  assert(engine.store.tasks().every(item => item.state === 'accepted'));
  assert.match(readText(path.join(env.run, 'report.md')), /목표 결과: 미입증/u);
});

test('repeated work without requirement progress ends finitely without claiming success', async t => {
  const env = fixture(t, { maxNoProgress: 1, maxGoalRounds: 10, maxRevisions: 0 });
  let workers = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') { workers++; return workerResult(env.workspace); }
    if (message.role === 'supervisor') return verdict(message.data.facts.map(fact => fact.id), 'unresolved', 'reject');
    if (message.role === 'goal') return {
      decision: 'continue', contract_revision: message.data.contract.revision,
      requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
        verdict: 'unknown', fact_ids: [], reason: 'The repeated approach has not established this requirement.' })),
      reason: 'Retry the same bounded check.', progress: 'No requirement gained relevant evidence.',
      next_tasks: [{ ...task(), depends_on: [] }], question: '',
    };
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  const completion = engine.store.completionStatus();
  assert.equal(workers, 2);
  assert.equal(completion.goal_outcome, 'not_established');
  assert.equal(completion.termination.reason, 'no_progress');
  assert.notEqual(engine.store.getMeta('goal:assessment').decision, 'achieved');
});

test('repeated needs_input in autonomous mode is bounded by the same no-progress policy', async t => {
  const env = fixture(t, { maxNoProgress: 1, maxGoalRounds: 10 });
  let reviews = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal') {
      reviews++;
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
  assert.equal(reviews, 2);
  assert.equal(engine.store.completionStatus().goal_outcome, 'not_established');
  assert.equal(engine.store.completionStatus().termination.reason, 'no_progress');
});

test('the persistent provider-attempt budget concludes without starting another task', async t => {
  const env = fixture(t, { maxAttempts: 3 });
  const roles = [];
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    roles.push(message.role);
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  const completion = engine.store.completionStatus();
  assert.equal(completion.goal_outcome, 'not_established');
  assert.equal(completion.termination.reason, 'budget_exhausted');
  assert.equal(engine.store.attemptCount(), 3);
  assert.deepEqual(roles, ['contract', 'contract_review', 'editor']);
  assert.equal(engine.store.tasks().length, 0);
});

test('controller failure budgets survive resume until configuration or input changes', async t => {
  const env = fixture(t, { maxControlFailures: 1 });
  let calls = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'contract') { calls++; throw new Error('contract provider failed'); }
    return defaultResult(message);
  });
  const first = new Engine(env.run, { providerFactory: factory });
  try { await assert.rejects(first.run(), /contract provider failed/u); }
  finally { first.close(); }
  assert.equal(calls, 1);

  const resumed = new Engine(env.run, { providerFactory: factory });
  try { await assert.rejects(resumed.run(), /누적 실패 상한/u); }
  finally { resumed.close(); }
  assert.equal(calls, 1);
  const store = new Store(env.run);
  try {
    assert.equal(store.getMeta('control:failures:contract').count, 1);
    const config = store.getMeta('config');
    store.setMeta('config', { ...config, roleSettings: { ...config.roleSettings, contract: { provider: 'claude' } } });
  }
  finally { store.close(); }

  const reconfigured = new Engine(env.run, { providerFactory: factory });
  try { await assert.rejects(reconfigured.run(), /contract provider failed/u); }
  finally { reconfigured.close(); }
  assert.equal(calls, 2);
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

test('an unchanged achieved run is idempotent even when its attempt budget is exactly spent', async t => {
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

test('attempt exhaustion defers review without consuming task failures and resumes after a budget increase', async t => {
  const env = fixture(t, { maxAttempts: 5, maxFailures: 1 });
  let workers = 0, reviews = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') { workers++; return workerResult(env.workspace); }
    if (message.role === 'supervisor') reviews++;
    return defaultResult(message);
  });
  const first = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await first.run(), 'completed');
    const pending = first.store.task(1);
    assert.equal(first.store.completionStatus().goal_outcome, 'not_established');
    assert.equal(pending.state, 'reviewing');
    assert.equal(pending.failures, 0);
    assert(pending.result);
    const config = first.store.getMeta('config');
    first.store.setMeta('config', { ...config, maxAttempts: 12 });
  } finally { first.close(); }

  const resumed = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.task(1).state, 'accepted');
    assert.equal(resumed.store.task(1).failures, 0);
    assert.equal(resumed.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(workers, 1);
    assert.equal(reviews, 1);
  } finally { resumed.close(); }
});

test('an exhausted goal-round budget is not spent again by unchanged resumes', async t => {
  const env = fixture(t, { maxGoalRounds: 1 });
  let goalCalls = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal') {
      goalCalls++;
      return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The requested outcome is not yet established.' })),
        reason: 'More work would be required.', progress: 'The first bounded attempt is complete.',
        next_tasks: [{ title: 'Another approach', brief: 'Try a distinct implementation approach.', scope: 'docs.runtime.alternative', depends_on: [] }], question: '',
      };
    }
    return defaultResult(message);
  });
  const first = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await first.run(), 'completed');
    assert.equal(first.store.completionStatus().goal_outcome, 'not_established');
    assert.equal(first.store.getMeta('goal:round'), 1);
  } finally { first.close(); }

  const resumed = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.completionStatus().goal_outcome, 'not_established');
    assert.equal(resumed.store.getMeta('goal:round'), 1);
    assert.equal(goalCalls, 1);
  } finally { resumed.close(); }

  const store = new Store(env.run);
  try { store.message('완료 조건에 새 출력 형식을 추가합니다.'); }
  finally { store.close(); }
  const revised = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await revised.run(), 'completed');
    assert.equal(revised.store.completionStatus().goal_outcome, 'not_established');
    assert.equal(revised.store.getMeta('goal:round'), 1);
    assert.equal(revised.store.getMeta('goal:contract').revision, 2);
    assert.equal(goalCalls, 1);
  } finally { revised.close(); }
});

test('a terminal candidate interrupted during editing resumes without another Goal round', async t => {
  const env = fixture(t, { maxGoalRounds: 1 });
  let engine, stopEditor = true, goalCalls = 0;
  const firstFactory = scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal') {
      goalCalls++;
      return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The requested outcome remains unestablished.' })),
        reason: 'The bounded attempt did not establish completion.', progress: 'One attempt was reviewed.',
        next_tasks: [{ title: 'Unused next step', brief: 'Would run only with more Goal rounds.', scope: 'docs.runtime.next', depends_on: [] }], question: '',
      };
    }
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
    if (message.role === 'goal') throw new Error('Goal must not run again');
    return defaultResult(message);
  }) });
  try {
    assert.equal(await resumed.run(), 'completed');
    assert.equal(resumed.store.completionStatus().goal_outcome, 'not_established');
    assert.equal(resumed.store.getMeta('goal:round'), 1);
    assert.equal(resumed.store.getMeta('goal:pending_terminal'), null);
    assert.equal(goalCalls, 1);
  } finally { resumed.close(); }
});

test('raising a stopped terminal budget discards the pending conclusion and continues Goal assessment', async t => {
  const env = fixture(t, { maxGoalRounds: 1 });
  let engine, interruptEditor = true, goalCalls = 0;
  const factory = scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal') {
      goalCalls++;
      if (goalCalls > 1) return defaultResult(message);
      return {
        decision: 'continue', contract_revision: message.data.contract.revision,
        requirement_evaluations: message.data.contract.requirements.map(requirement => ({ requirement_id: requirement.id,
          verdict: 'unknown', fact_ids: [], reason: 'The first bounded assessment did not establish this requirement.' })),
        reason: 'Another Goal round is needed.', progress: 'The initial task was reviewed.',
        next_tasks: [{ title: 'Additional verification', brief: 'Check the remaining completion condition.', scope: 'docs.runtime.next', depends_on: [] }],
        question: '',
      };
    }
    if (message.role === 'editor' && interruptEditor) {
      interruptEditor = false;
      engine.stop();
      throw new Error('editor interrupted');
    }
    return defaultResult(message);
  });

  engine = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await engine.run(), 'stopped');
    assert.equal(engine.store.getMeta('goal:round'), 1);
    assert(engine.store.getMeta('goal:pending_terminal'));
    const config = engine.store.getMeta('config');
    engine.store.setMeta('config', { ...config, maxGoalRounds: 2 });
  } finally { engine.close(); }

  engine = new Engine(env.run, { providerFactory: factory });
  try {
    assert.equal(await engine.run(), 'completed');
    assert.equal(engine.store.completionStatus().goal_outcome, 'achieved');
    assert.equal(engine.store.getMeta('goal:round'), 2);
    assert.equal(engine.store.getMeta('goal:pending_terminal'), null);
    assert.equal(goalCalls, 2);
    assert(engine.store.events(0, 1000).some(event => event.type === 'goal.pending_terminal_discarded'));
  } finally { engine.close(); }
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
