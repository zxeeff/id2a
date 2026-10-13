import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine, createRun } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { acquireLock, readText, sleep, writeJSON } from '../src/util.mjs';
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
        decision: 'continue', reason: 'The first approach stalled.', progress: 'Evidence collection needs an alternative.', fact_ids: [],
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

test('recovery resumes the interrupted worker session and retains the same task', async t => {
  const env = fixture(t);
  const store = new Store(env.run);
  const id = store.addTask(task()); store.setMeta('planned', true);
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
      decision: 'needs_input', reason: 'An external choice is strictly required.', progress: 'Implementation is otherwise verified.',
      fact_ids: message.data.facts.map(fact => fact.id), next_tasks: [], question: 'Choose the external deployment account.',
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
        decision: 'needs_input', reason: 'The user has not approved one of two review scopes.', progress: 'Candidate scopes are known.',
        fact_ids: message.data.facts.map(fact => fact.id), next_tasks: [], question: 'Choose scope A or B.',
      };
      if (reviews === 2) {
        assert.match(message.data.context.controller_feedback, /무인 연속 실행 정책/u);
        return {
          decision: 'continue', reason: 'Use the bounded recommended scope without waiting.', progress: 'The reversible choice was recorded as an assumption.',
          fact_ids: message.data.facts.map(fact => fact.id),
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
