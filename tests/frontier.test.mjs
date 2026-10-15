import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, configuration } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { admitRefill, decisionAwake, frontierSnapshot, validateRefill } from '../src/frontier.mjs';
import { Resources } from '../src/resources.mjs';
import { fixture, task, workerResult, scriptedFactory, defaultResult } from './helpers.mjs';
import { hash, sleep } from '../src/util.mjs';

const read = { workspace: 'read', cpu: 1 };
const proposal = (name, extra = {}) => ({ ...task(name), logical_key: 'goal.' + name,
  resources: read, depends_on: [], existing_dependencies: [], ...extra });
const ready = tasks => ({ status: 'READY', summary: 'Necessary independent work.', tasks, wake: { kind: 'none', task_ids: [] } });
const exhausted = () => ({ status: 'EXHAUSTED', summary: 'Current work covers all known requirements.', tasks: [], wake: { kind: 'none', task_ids: [] } });
const gate = () => Promise.withResolvers();
function storeFixture(t) {
  const env = fixture(t);
  const store = new Store(env.run); env.dispose(() => store.close());
  store.setMeta('control:lease', 0);
  store.setMeta('frontier:state', { phase: 'RUNNING', rounds: 0, cycle: 1 });
  return { ...env, store };
}
function request(store, id = 'test') {
  const value = { id, limit: 8, controlRevision: store.getMeta('control:revision', 0) || 0, snapshot: frontierSnapshot(store) };
  store.setMeta('frontier:request', value); return value;
}
const admit = (store, req, result) => admitRefill(store, req, result, { epoch: 0, cpuCapacity: 4 });

test('rolling refill executes independent work while an earlier task is still running', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 2, reviewers: 1, cpuCapacity: 4, frontierTarget: 4 });
  const long = gate(); t.after(() => long.resolve());
  let longRunning = false, independentRan = false, refillCalls = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    const { role, data } = message;
    if (role === 'planner') {
      assert(message.request.schema.properties.tasks.items.required.includes('resources'));
      assert(message.request.schema.properties.tasks.items.required.includes('logical_key'));
    }
    if (role === 'planner' && !data.context?.operation) return { summary: 'Start long task', tasks: [{ ...task('Long'), resources: read, depends_on: [] }] };
    if (role === 'planner') {
      refillCalls++;
      assert(data.contract.requirements.length);
      assert.equal(data.context.capacity.workers, 2);
      assert(data.context.capacity.occupied.some(item => item.task === 1));
      return refillCalls === 1 ? ready([proposal('Independent')]) : exhausted();
    }
    if (role === 'worker') {
      if (data.task.id === 1) { longRunning = true; await long.promise; longRunning = false; }
      else { independentRan = true; assert.equal(longRunning, true); long.resolve(); }
      return workerResult(env.workspace);
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(independentRan, true);
  assert.equal(engine.store.tasks().length, 2);
  assert(refillCalls <= 4);
});

test('EXHAUSTED closes the frontier and reaches Goal without refill spin', { timeout: 20000 }, async t => {
  const env = fixture(t, { frontierTarget: 10 });
  const worker = gate(); t.after(() => worker.resolve());
  let refills = 0, evaluated = false;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'planner' && message.data.context?.operation) { refills++; return exhausted(); }
    if (message.role === 'worker') { await worker.promise; return workerResult(env.workspace); }
    if (message.role === 'goal') {
      evaluated = true;
      assert.equal(engine.frontierState().phase, 'EVALUATING');
      assert.equal(engine.activeTasks.size, 0);
    }
    return defaultResult(message);
  }), onEvent: event => { if (event.type === 'frontier.phase' && event.phase === 'CLOSING') worker.resolve(); } });
  env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(refills, 1); assert(evaluated);
  assert(engine.store.events(0, 1000).some(event => event.type === 'scheduler.idle' && event.reasons.includes('exhausted_or_no_useful_work')));
});

test('an in-flight refill cannot block review or dependent work after its original worker finishes', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 2, cpuCapacity: 3 });
  const started = gate(), dependent = gate();
  let planning = false, reviewedDuringPlanning = false, ranDuringPlanning = false;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    const { role, data } = message;
    if (role === 'planner' && !data.context?.operation) return { summary: 'A prerequisite and its dependent', tasks: [
      { ...task('First'), resources: read, depends_on: [] }, { ...task('Dependent'), resources: read, depends_on: [0] },
    ] };
    if (role === 'planner') {
      planning = true; started.resolve(); await dependent.promise; planning = false;
      return exhausted();
    }
    if (role === 'worker') {
      if (data.task.id === 1) await started.promise;
      else { ranDuringPlanning = planning; dependent.resolve(); }
      return workerResult(env.workspace);
    }
    if (role === 'supervisor' && data.task.id === 1) reviewedDuringPlanning = planning;
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert(reviewedDuringPlanning); assert(ranDuringPlanning);
  assert(engine.store.events(0, 1000).some(event => event.type === 'frontier.stale'));
});

test('DEFERRED task wake ignores unrelated work, logs and knowledge changes', t => {
  const { store } = storeFixture(t);
  const first = store.addTask(task('First')), other = store.addTask(task('Other'));
  const req = request(store);
  const result = { status: 'DEFERRED', summary: 'Wait for First to be independently verified.', tasks: [], wake: { kind: 'task_settled', task_ids: [first] } };
  assert.deepEqual(admit(store, req, result).admitted, []);
  const decision = store.getMeta('frontier:decision');
  assert.equal(decisionAwake(decision, frontierSnapshot(store), store.tasks()), false);
  store.updateTask(other, { state: 'accepted' });
  store.event('test.unrelated', {});
  assert.equal(decisionAwake(decision, frontierSnapshot(store), store.tasks()), false);
  store.updateTask(first, { state: 'reviewing' });
  assert.equal(decisionAwake(decision, frontierSnapshot(store), store.tasks()), false);
  store.updateTask(first, { state: 'stalled' });
  assert.equal(decisionAwake(decision, frontierSnapshot(store), store.tasks()), true);
});

test('DEFERRED knowledge and instruction wakes are scoped to their stated changes', t => {
  const { store } = storeFixture(t);
  const id = store.addTask(task());
  const snapshot = frontierSnapshot(store);
  const decision = kind => ({ status: 'DEFERRED', snapshot, wake: { kind, task_ids: [] } });
  store.updateTask(id, { state: 'running' });
  assert.equal(decisionAwake(decision('knowledge_changed'), frontierSnapshot(store), store.tasks()), false);
  assert.equal(decisionAwake(decision('instruction_changed'), frontierSnapshot(store), store.tasks()), false);
  store.message('Inspect one more relevant condition.');
  assert.equal(decisionAwake(decision('instruction_changed'), frontierSnapshot(store), store.tasks()), true);
  assert.throws(() => validateRefill({ status: 'DEFERRED', summary: 'Wait.', tasks: [], wake: { kind: 'none', task_ids: [] } }, store.tasks(), 4, 4), /wake condition/u);
});

test('stale, paused and fenced refill results cannot commit', t => {
  const { store } = storeFixture(t);
  const id = store.addTask(task('Existing'));
  const old = request(store);
  store.updateTask(id, { state: 'running' });
  assert.equal(admit(store, old, ready([proposal('New')])).stale, true);
  const paused = request(store, 'paused'); store.requestControl('paused');
  assert.equal(admit(store, paused, ready([proposal('New')])).stale, true);
  store.requestControl('running');
  const fenced = request(store, 'fenced'); store.setMeta('control:epoch', 1);
  assert.equal(admit(store, fenced, ready([proposal('New')])).stale, true);
  assert.equal(store.tasks().length, 1);
});

test('refill admission is transactional, idempotent and deduplicates stable keys and exact content', t => {
  const { store } = storeFixture(t);
  const req = request(store);
  const tasks = [proposal('One'), proposal('Renamed one', { logical_key: 'goal.One' }),
    proposal('Two', { depends_on: [1] }), proposal('One', { logical_key: 'another.key' })];
  const result = admit(store, req, ready(tasks));
  assert.equal(result.admitted.length, 2);
  assert.equal(result.duplicates.length, 2);
  assert.deepEqual(store.task(result.admitted[1]).dependencies, [result.admitted[0]]);
  assert.equal(admit(store, req, ready(tasks)).replayed, true);
  const retry = request(store, 'retry');
  assert.equal(admit(store, retry, ready(tasks)).admitted.length, 0);
  assert.equal(store.tasks().length, 2);
  const invalid = request(store, 'invalid');
  assert.throws(() => admit(store, invalid, ready([proposal('Third'), proposal('Invalid', { existing_dependencies: [999] })])), /Unknown existing/u);
  assert.equal(store.tasks().length, 2);
  assert.equal(store.getMeta('frontier:receipt:invalid'), null);
  assert.throws(() => admit(store, invalid, ready([proposal('Cycle', { depends_on: [0] })])), /earlier proposal/u);
});

test('pause and resume fence a refill even when the ledger content has not changed', t => {
  const { store } = storeFixture(t);
  const req = request(store);
  store.requestControl('paused');
  store.requestControl('running');
  assert.equal(frontierSnapshot(store).key, req.snapshot.key);
  assert.equal(admit(store, req, ready([proposal('Late')])).stale, true);
  assert.equal(store.tasks().length, 0);
});

test('dedup aliases survive later renamed proposals and are honored by ordinary admission', t => {
  const { store, run, dispose } = storeFixture(t);
  const first = proposal('Canonical');
  const alias = { ...first, logical_key: 'alternate.outcome' };
  const result = admit(store, request(store), ready([first, alias]));
  assert.equal(result.admitted.length, 1);
  const reopened = new Store(run); dispose(() => reopened.close());
  const renamed = proposal('Different wording', { logical_key: alias.logical_key });
  assert.equal(reopened.existingTask(renamed), result.admitted[0]);
  assert.equal(reopened.addTask({ ...task('Ordinary followup'), logical_key: alias.logical_key }), null);
  const receipt = admit(reopened, request(reopened, 'later'), ready([renamed]));
  assert.deepEqual(receipt.admitted, []);
  assert.deepEqual(receipt.duplicates, result.admitted);
  assert.equal(reopened.tasks().length, 1);
});

test('read-only access to an unmigrated legacy ledger preserves its controller snapshot', t => {
  const { store, run, dispose } = storeFixture(t);
  store.addTask(task());
  store.db.exec('DROP INDEX tasks_logical_key; ALTER TABLE tasks DROP COLUMN resources; ALTER TABLE tasks DROP COLUMN logical_key;');
  const tasks = store.db.prepare('SELECT * FROM tasks ORDER BY id').all().map(row => ({
    ...row, dependencies: JSON.parse(row.dependencies), result: row.result ? JSON.parse(row.result) : null,
  }));
  const legacySnapshot = hash(JSON.stringify({ facts: [], tasks, digests: [] }));
  const reader = new Store(run, { readOnly: true }); dispose(() => reader.close());
  assert.equal(reader.ledgerView().snapshot, legacySnapshot);
  assert.equal(reader.ledgerPage({ collection: 'tasks', snapshot: legacySnapshot }).items.length, 1);
  const migrated = new Store(run); dispose(() => migrated.close());
  assert.deepEqual(migrated.task(1).resources, { workspace: 'write', cpu: 1 });
});

test('refill reserves CPU capacity, permits a concurrent writer, and never duplicates an in-flight request', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 3, reviewers: 2, cpuCapacity: 3, frontierTarget: 8 });
  const entered = gate(), finish = gate(); t.after(() => finish.resolve());
  let planning = 0, calls = 0, checked = false;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'planner' && !message.data.context?.operation) return {
      summary: 'A weighted writer', tasks: [{ ...task(), resources: { workspace: 'write', cpu: 2 }, depends_on: [] }],
    };
    if (message.role === 'planner') {
      calls++; planning++; assert.equal(planning, 1);
      const occupied = engine.resources.occupied();
      assert.equal(occupied.reduce((sum, item) => sum + item.cpu, 0), 3);
      assert(occupied.some(item => item.workspace === 'write'));
      assert(occupied.some(item => item.workspace === 'none' && item.process_state === 'starting'));
      entered.resolve(); await finish.promise; planning--;
      return exhausted();
    }
    if (message.role === 'worker') {
      await entered.promise;
      for (let index = 0; index < 3; index++) { engine.maybeRefill([]); await sleep(20); }
      assert.equal(calls, 1); checked = true; finish.resolve();
      return workerResult(env.workspace);
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed'); assert(checked);
  assert.deepEqual(engine.store.getMeta('scheduler:reservations'), []);
});

test('a fully occupied CPU budget suppresses refill without consuming its call budget', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 2, cpuCapacity: 1 });
  let refills = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'planner' && message.data.context?.operation) { refills++; return exhausted(); }
    if (message.role === 'worker') { await sleep(350); return workerResult(env.workspace); }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(refills, 0); assert.equal(engine.frontierState().rounds, 0);
});

test('invalid old graphs and failed dependencies become blocked and remain visible', t => {
  const { store } = storeFixture(t);
  const first = store.addTask(task('First'));
  const child = store.addTask(task('Child'), { dependencies: [first] });
  store.updateTask(first, { state: 'stalled' });
  assert.deepEqual(store.readyTasks(), []);
  assert.equal(store.task(child).state, 'blocked');
  const broken = store.addTask(task('Broken'));
  store.db.prepare('UPDATE tasks SET dependencies=? WHERE id=?').run(JSON.stringify([broken]), broken);
  assert.deepEqual(store.readyTasks(), []);
  assert.match(store.task(broken).feedback, /cycle/u);
});

test('a cyclic legacy task reaches Goal as blocked work and requires a substantive replan', { timeout: 20000 }, async t => {
  const env = fixture(t, { maxAttempts: 3 });
  let goals = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal') {
      assert.equal(engine.frontierState().phase, 'EVALUATING');
      assert.equal(engine.activeTasks.size, 0);
      if (++goals === 1) {
        assert(message.data.context.tasks.some(item => item.state === 'blocked'));
        const result = defaultResult(message);
        return { ...result, decision: 'continue', reason: 'The blocked work has not established the goal.',
          requirement_evaluations: result.requirement_evaluations.map(item => ({ ...item, verdict: 'unknown', fact_ids: [] })),
          next_tasks: [{ ...task('Independent recovery'), depends_on: [] }] };
      }
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const broken = engine.store.addTask(task('Legacy cycle'));
  engine.store.db.prepare('UPDATE tasks SET dependencies=? WHERE id=?').run(JSON.stringify([broken]), broken);
  engine.store.setMeta('planned', true);
  assert.equal(await engine.run(), 'completed');
  assert.equal(goals, 2); assert.equal(engine.store.task(broken).state, 'blocked');
  assert.equal(engine.store.task(2).state, 'accepted');
});

test('shared writers exclude readers and weighted CPU capacity is enforced', t => {
  const { store } = storeFixture(t);
  const resources = new Resources(store);
  const reader = { id: 1, resources: read };
  const writer = { id: 2, resources: { workspace: 'write', cpu: 2 } };
  assert(resources.reserve(reader, false, 3));
  assert.equal(resources.reserve(writer, false, 3), false);
  assert(resources.reserve({ id: 3, resources: { workspace: 'read', cpu: 2 } }, false, 3));
  assert.equal(resources.reserve({ id: 4, resources: read }, false, 3), false);
  resources.release(1); resources.release(3);
  assert(resources.reserve(writer, false, 3));
  assert.equal(resources.reserve(reader, true, 3), false);
});

test('live or uncertain provider processes retain reservations across stop and recovery', t => {
  const { store } = storeFixture(t);
  const resources = new Resources(store);
  resources.reserve({ id: 1 }, false, 2);
  resources.process(1, 'running', process.pid);
  store.setMeta('control:epoch', 999);
  assert.equal(resources.release(1), false);
  assert.throws(() => new Resources(store).recover(), /unresolved/u);
  resources.process(1, 'starting');
  assert.throws(() => new Resources(store).recover(), /unresolved/u);
  resources.process(1, 'stopped', process.pid);
  assert(resources.release(1));
  new Resources(store).recover();
  assert.deepEqual(store.getMeta('scheduler:reservations'), []);
});

test('slow review leaves a worker slot available for a compatible independent reader', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 1, reviewers: 1, cpuCapacity: 2, frontierTarget: 0 });
  const review = gate(); t.after(() => review.resolve());
  let reviewing = false, parallel = false;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    const { role, data } = message;
    if (role === 'planner') return { summary: 'Two independent readers', tasks: [
      { ...task('One'), resources: read, depends_on: [] }, { ...task('Two'), resources: read, depends_on: [] },
    ] };
    if (role === 'supervisor' && data.task.id === 1) { reviewing = true; await review.promise; reviewing = false; }
    if (role === 'worker') {
      if (data.task.id === 2) { parallel = reviewing; review.resolve(); }
      return workerResult(env.workspace);
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed'); assert(parallel);
});

test('writer tasks never overlap a reader or independent supervisor', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 3, reviewers: 2, cpuCapacity: 4, frontierTarget: 0 });
  let writing = 0, reading = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    const { role, data } = message;
    if (role === 'planner') return { summary: 'Mixed work', tasks: [
      { ...task('Writer'), depends_on: [] }, { ...task('Reader'), resources: read, depends_on: [] }, { ...task('Second writer'), depends_on: [] },
    ] };
    if (role === 'worker' || role === 'supervisor') {
      const writer = role === 'worker' && data.task.resources.workspace === 'write';
      if (writer) { assert.equal(writing + reading, 0); writing++; }
      else { assert.equal(writing, 0); reading++; }
      await sleep(30);
      if (writer) writing--; else reading--;
      if (role === 'worker') return workerResult(env.workspace);
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
});

test('bounded productive refills enter CLOSING and give Goal access', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 2, cpuCapacity: 3, maxRefillsPerCycle: 1, frontierTarget: 5 });
  const initial = gate(); t.after(() => initial.resolve());
  let refills = 0, goals = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'planner' && !message.data.context?.operation) return { summary: 'First', tasks: [{ ...task(), resources: read, depends_on: [] }] };
    if (message.role === 'planner') { refills++; return ready([proposal('More')]); }
    if (message.role === 'worker') {
      if (message.data.task.id === 1) await initial.promise;
      else initial.resolve();
      return workerResult(env.workspace);
    }
    if (message.role === 'goal') goals++;
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(refills, 1); assert.equal(goals, 1);
  assert(engine.store.events(0, 1000).some(event => event.type === 'frontier.phase' && event.reason === 'refill_budget'));
});

test('pause discards an in-flight refill; explicit stop drains it and resume continues required work', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 2, cpuCapacity: 3 });
  const planned = gate(), finishPlan = gate(), discarded = gate();
  let stoppedWorker = false;
  const first = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'planner' && message.data.context?.operation) {
      planned.resolve(); await finishPlan.promise;
      return ready([proposal('Must not commit while paused')]);
    }
    if (message.role === 'worker') {
      await new Promise(resolve => message.request.signal.addEventListener('abort', resolve, { once: true }));
      stoppedWorker = true; throw new Error('Explicit stop.');
    }
    return defaultResult(message);
  }), onEvent: event => { if (event.type === 'frontier.stale') discarded.resolve(); } });
  try {
    const running = first.run();
    await planned.promise;
    first.store.requestControl('paused'); finishPlan.resolve();
    await discarded.promise;
    assert.equal(first.store.tasks().length, 1);
    assert.equal(first.store.getMeta('control'), 'paused');
    first.stop();
    assert.equal(await running, 'stopped'); assert(stoppedWorker);
    assert.equal(first.refillPromise, null);
    assert.deepEqual(first.store.getMeta('scheduler:reservations'), []);
  } finally { first.close(); }
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    return defaultResult(message);
  }) }); env.dispose(() => resumed.close());
  assert.equal(await resumed.run(), 'completed');
  assert.equal(resumed.store.tasks().length, 1);
});

test('CLOSING is durable across stop/resume and Goal reopens RUNNING for a named gap', { timeout: 20000 }, async t => {
  const env = fixture(t, { workers: 2, cpuCapacity: 3 });
  let first;
  first = new Engine(env.run, { providerFactory: scriptedFactory(async message => {
    if (message.role === 'worker') {
      await new Promise(resolve => message.request.signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('Explicit stop.');
    }
    return defaultResult(message);
  }), onEvent: event => { if (event.type === 'frontier.phase' && event.phase === 'CLOSING') first.stop(); } });
  try {
    assert.equal(await first.run(), 'stopped');
    assert.equal(first.frontierState().phase, 'CLOSING');
  } finally { first.close(); }
  let goals = 0, refills = 0;
  const resumed = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'planner') { refills++; return exhausted(); }
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'goal' && ++goals === 1) {
      const result = defaultResult(message);
      return { ...result, decision: 'continue', reason: 'One required gap remains.',
        requirement_evaluations: result.requirement_evaluations.map(item => ({ ...item, verdict: 'unknown', fact_ids: [] })),
        next_tasks: [{ ...task('Targeted gap'), depends_on: [] }] };
    }
    return defaultResult(message);
  }) }); env.dispose(() => resumed.close());
  assert.equal(await resumed.run(), 'completed');
  assert.equal(refills, 0); assert.equal(goals, 2);
  assert(resumed.store.events(0, 1000).some(event => event.type === 'frontier.phase' && event.phase === 'RUNNING' && event.reason === 'goal_targeted_work'));
});

test('frontier configuration validates ceilings and supports disabling rolling refill', t => {
  const env = fixture(t);
  assert.equal(configuration({ workspace: env.workspace }).frontierTarget, 10);
  assert.equal(configuration({ workspace: env.workspace, frontierTarget: 0 }).frontierTarget, 0);
  assert.throws(() => configuration({ workspace: env.workspace, maxRefillsPerCycle: 0 }));
  assert.throws(() => configuration({ workspace: env.workspace, cpuCapacity: 0 }));
});

test('idle telemetry distinguishes exhausted work from budget closure, evaluation and pause', t => {
  const env = fixture(t);
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  engine.store.addTask(task());
  const work = engine.store.readyTasks();
  engine.frontierPhase('CLOSING', 'refill_budget');
  engine.recordIdle(work);
  assert(engine.store.getMeta('scheduler:idle').reasons.includes('frontier_closing'));
  assert(!engine.store.getMeta('scheduler:idle').reasons.includes('exhausted_or_no_useful_work'));
  engine.frontierPhase('EVALUATING', 'stable_frontier');
  engine.recordIdle([]);
  assert(engine.store.getMeta('scheduler:idle').reasons.includes('goal_evaluating'));
  engine.store.requestControl('paused');
  engine.recordIdle(work);
  assert(engine.store.getMeta('scheduler:idle').reasons.includes('control_paused'));
});

test('invalid followup claims cannot survive worker submission and block Goal indefinitely', { timeout: 20000 }, async t => {
  const env = fixture(t);
  let workers = 0, triage = 0;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') {
      const result = workerResult(env.workspace);
      if (++workers === 1) result.followups = [{ ...task('Invalid followup'), resources: { workspace: 'read', cpu: 0 } }];
      return result;
    }
    if (message.role === 'triage') triage++;
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(workers, 2); assert.equal(triage, 0);
  assert.equal(engine.store.tasks().length, 1);
});

test('a bad later Goal resource claim cannot admit an earlier task from that proposal', t => {
  const env = fixture(t);
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  assert.throws(() => engine.queueGoalTasks([
    { ...task('Valid first'), depends_on: [] },
    { ...task('Invalid second'), resources: { workspace: 'read', cpu: 0 }, depends_on: [0] },
  ], 1, 'Required gaps'), /CPU weight/u);
  assert.equal(engine.store.tasks().length, 0);
});
