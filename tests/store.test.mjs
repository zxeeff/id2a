import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { hash, readText } from '../src/util.mjs';
import { fixture, task, workerResult, verdict } from './helpers.mjs';

function setup(t) {
  const environment = fixture(t);
  const store = new Store(environment.run);
  environment.dispose(() => store.close());
  const directory = path.join(environment.run, 'work'); fs.mkdirSync(directory);
  return { ...environment, store, directory };
}

test('artifact snapshots survive source changes, and altered snapshots fail review', t => {
  const { store, workspace, directory } = setup(t);
  const id = store.addTask(task());
  const ids = store.submitWorker(id, workerResult(workspace), directory, workspace);
  const fact = store.fact(ids[0]);
  assert.equal(fact.state, 'proposed');
  assert.equal(hash(fs.readFileSync(fact.evidence[0].artifact)), fact.evidence[0].sha256);
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Changed source');
  assert.match(readText(fact.evidence[0].artifact), /Node.js 24/u);
  fs.writeFileSync(fact.evidence[0].artifact, 'Tampered snapshot');
  assert.throws(() => store.applyVerdict(id, verdict(ids), ids), /해시 불일치/u);
  assert.equal(store.fact(ids[0]).state, 'proposed');
});

test('missing evidence cannot create facts or advance a task', t => {
  const { store, workspace, directory } = setup(t);
  const id = store.addTask(task());
  const output = workerResult(workspace); output.facts[0].evidence = [];
  assert.throws(() => store.submitWorker(id, output, directory, workspace), /증거 파일/u);
  assert.equal(store.listFacts().length, 0);
  assert.equal(store.task(id).state, 'queued');
});

test('evidence rejects directory traversal, prefix collisions, and junction escapes', t => {
  const { store, root, workspace, directory } = setup(t);
  const outside = path.join(root, 'workspace-other'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside');
  const id = store.addTask(task());
  const output = workerResult(workspace);
  output.facts[0].evidence[0].path = path.join(outside, 'private.txt');
  assert.throws(() => store.submitWorker(id, output, directory, workspace), /폴더 밖/u);
  fs.symlinkSync(outside, path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  output.facts[0].evidence[0].path = path.join(workspace, 'link', 'private.txt');
  assert.throws(() => store.submitWorker(id, output, directory, workspace), /폴더 밖/u);
  output.facts[0].evidence[0].path = path.relative(directory, path.join(outside, 'private.txt'));
  assert.throws(() => store.submitWorker(id, output, directory, workspace), /폴더 밖/u);
});

test('repeated claims deduplicate but preserve each task and evidence origin', t => {
  const { store, workspace, directory } = setup(t);
  const one = store.addTask(task('One')), two = store.addTask(task('Two'));
  const first = store.submitWorker(one, workerResult(workspace), directory, workspace);
  const second = store.submitWorker(two, workerResult(workspace, ' Node.js 24 or newer is required. ', 'DOCS.RUNTIME.NODE'), directory, workspace);
  assert.deepEqual(first, second);
  assert.equal(store.listFacts().length, 1);
  assert.deepEqual(store.fact(first[0]).origins, [one, two]);
  assert.equal(store.fact(first[0]).state, 'proposed');
});

test('independent review requires exact IDs and cannot accept unverified facts', t => {
  const { store, workspace, directory } = setup(t);
  const id = store.addTask(task());
  const ids = store.submitWorker(id, workerResult(workspace), directory, workspace);
  assert.throws(() => store.applyVerdict(id, verdict([999]), ids), /정확히 한 번/u);
  assert.throws(() => store.applyVerdict(id, verdict(ids, 'unresolved'), ids), /미검증/u);
  assert.equal(store.context(store.task(id)).facts.length, 0);
  store.applyVerdict(id, verdict(ids), ids);
  assert.equal(store.context(store.task(id)).facts[0].state, 'verified');
});

test('contradictory confirmed claims become conflicts and invalidate digests', t => {
  const { store, workspace, directory } = setup(t);
  const one = store.addTask(task('First')), two = store.addTask(task('Second'));
  const first = store.submitWorker(one, workerResult(workspace), directory, workspace);
  store.applyVerdict(one, verdict(first), first);
  store.addDigest({ scope: 'docs.runtime', summary: 'Node.js 24+', fact_ids: first });
  const second = store.submitWorker(two, workerResult(workspace, 'Node.js 25 is required.'), directory, workspace);
  store.applyVerdict(two, verdict(second), second);
  assert.equal(store.fact(first[0]).state, 'conflicted');
  assert.equal(store.fact(second[0]).state, 'conflicted');
  assert.equal(store.context(store.task(one)).digests.length, 0);
  const conflict = store.addTask(task('Resolve conflict'), { kind: 'conflict' });
  const resolution = { decision: 'accept', reason: 'Only the original claim matches the evidence.', fact_verdicts: [
    { id: first[0], state: 'verified', reason: 'Matches line 1' },
    { id: second[0], state: 'refuted', reason: 'Does not match line 1' },
  ] };
  store.applyVerdict(conflict, resolution, [...first, ...second]);
  assert.equal(store.fact(first[0]).state, 'verified');
  assert.equal(store.fact(second[0]).state, 'refuted');
});

test('FTS handles punctuation and context packs have a finite payload budget', t => {
  const { store, workspace, directory } = setup(t);
  const id = store.addTask(task());
  const ids = store.submitWorker(id, workerResult(workspace), directory, workspace);
  store.applyVerdict(id, verdict(ids), ids);
  assert.equal(store.search('docs.runtime.node: " OR 1=1 --')[0].id, ids[0]);
  const context = store.context(store.task(id), 300);
  assert(JSON.stringify(context.facts).length + JSON.stringify(context.digests).length + JSON.stringify(context.scopes).length <= 300);
  assert.equal(context.coverage.facts.total, 1);
  assert.equal(context.coverage.facts.truncated, context.facts.length < 1);
  assert.equal(context.lookup.tool, 'ledger_page');
  assert.deepEqual(store.listFacts({ scope: 'docs.runtime' }).map(fact => fact.id), ids);
  assert.equal(store.listFacts({ scope: 'docs.runtime_%' }).length, 0);
});

test('negative results also need independent evidence and are available to later tasks', t => {
  const { store, workspace, directory } = setup(t);
  const id = store.addTask(task());
  const output = workerResult(workspace, 'The document has no Python requirement.', 'docs.runtime.python');
  output.facts[0].kind = 'dead_end';
  const ids = store.submitWorker(id, output, directory, workspace);
  store.applyVerdict(id, verdict(ids), ids);
  assert.equal(store.context(store.task(id)).facts[0].kind, 'dead_end');
});

test('current evidence requires each file from one submission while allowing a later complete submission', t => {
  const { store, workspace, directory } = setup(t);
  const extra = path.join(workspace, 'extra.txt');
  fs.writeFileSync(extra, 'Supporting detail.\n', 'utf8');
  const one = store.addTask(task('Composite evidence'));
  const composite = workerResult(workspace);
  composite.facts[0].evidence.push({ path: extra, note: 'Supporting detail' });
  const first = store.submitWorker(one, composite, directory, workspace);
  store.applyVerdict(one, verdict(first), first);
  const before = store.evidenceStatus();
  assert.equal(before.facts[first[0]], true);
  fs.writeFileSync(extra, 'Changed detail.\n', 'utf8');
  const stale = store.evidenceStatus();
  assert.equal(stale.facts[first[0]], false);
  assert.notEqual(stale.snapshot, before.snapshot);

  const two = store.addTask(task('Independent evidence'));
  const second = store.submitWorker(two, workerResult(workspace), directory, workspace);
  store.applyVerdict(two, verdict(second), second);
  assert.deepEqual(second, first);
  assert.equal(store.evidenceStatus().facts[first[0]], true);
});

test('a revised submission from the same task replaces its stale evidence set', t => {
  const { store, workspace, directory } = setup(t);
  const extra = path.join(workspace, 'extra.txt');
  fs.writeFileSync(extra, 'Initial supporting detail.\n', 'utf8');
  const id = store.addTask(task('Revised composite evidence'));
  const initial = workerResult(workspace);
  initial.facts[0].evidence.push({ path: extra, note: 'Supporting detail' });
  const first = store.submitWorker(id, initial, directory, workspace);
  store.applyVerdict(id, verdict(first), first);

  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Node.js 24 or newer.\nUpdated verification.\n', 'utf8');
  fs.writeFileSync(extra, 'Updated supporting detail.\n', 'utf8');
  store.updateTask(id, { state: 'queued', result: null, revisions: 1 });
  const revised = workerResult(workspace);
  revised.facts[0].evidence.push({ path: extra, note: 'Supporting detail' });
  const second = store.submitWorker(id, revised, directory, workspace);
  store.applyVerdict(id, verdict(second), second);

  assert.deepEqual(second, first);
  assert.deepEqual([...new Set(store.fact(first[0]).evidence.map(item => item.submission))], [1, 2]);
  assert.equal(store.evidenceStatus().facts[first[0]], true);
});

test('shared evidence remains a member of every revised submission that cited it', t => {
  const { store, workspace, directory } = setup(t);
  const fileB = path.join(workspace, 'b.txt'), fileC = path.join(workspace, 'c.txt');
  fs.writeFileSync(fileB, 'Evidence B.\n', 'utf8');
  fs.writeFileSync(fileC, 'Evidence C.\n', 'utf8');
  const id = store.addTask(task('Overlapping submissions'));
  const firstResult = workerResult(workspace);
  firstResult.facts[0].evidence.push({ path: fileB, note: 'B' });
  const first = store.submitWorker(id, firstResult, directory, workspace);
  store.applyVerdict(id, verdict(first), first);

  store.updateTask(id, { state: 'queued', result: null, revisions: 1 });
  const secondResult = workerResult(workspace);
  secondResult.facts[0].evidence.push({ path: fileC, note: 'C' });
  const second = store.submitWorker(id, secondResult, directory, workspace);
  store.applyVerdict(id, verdict(second), second);
  assert.deepEqual(second, first);
  const shared = store.fact(first[0]).evidence.filter(item => item.source === path.join(workspace, 'notes.txt'));
  assert.deepEqual(shared.map(item => item.submission), [1, 2]);

  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Changed shared evidence.\n', 'utf8');
  assert.equal(store.evidenceStatus().facts[first[0]], false);
});

test('identical evidence files retain their distinct sources and both must remain current', t => {
  const { store, workspace, directory } = setup(t);
  const original = path.join(workspace, 'notes.txt');
  const copy = path.join(workspace, 'copy.txt');
  fs.copyFileSync(original, copy);
  const id = store.addTask(task('Distinct identical evidence sources'));
  const result = workerResult(workspace);
  result.facts[0].evidence.push({ path: copy, note: result.facts[0].evidence[0].note });
  const ids = store.submitWorker(id, result, directory, workspace);
  store.applyVerdict(id, verdict(ids), ids);

  const evidence = store.fact(ids[0]).evidence;
  assert.deepEqual(evidence.map(item => item.source), [original, copy]);
  assert.equal(new Set(evidence.map(item => item.sha256)).size, 1);
  assert.equal(new Set(evidence.map(item => item.note)).size, 1);
  assert.equal(store.evidenceStatus().facts[ids[0]], true);
  fs.unlinkSync(copy);
  assert.equal(store.evidenceStatus().facts[ids[0]], false);
});

for (const hasSubmission of [false, true]) {
test(`${hasSubmission ? 'Submission-only' : 'Legacy'} evidence rows migrate without losing identity or currentness`, t => {
  const env = fixture(t);
  const directory = path.join(env.run, 'legacy-work'); fs.mkdirSync(directory);
  const initial = new Store(env.run);
  const taskID = initial.addTask(task('Legacy evidence'));
  const ids = initial.submitWorker(taskID, workerResult(env.workspace), directory, env.workspace);
  initial.applyVerdict(taskID, verdict(ids), ids);
  if (hasSubmission) initial.db.prepare('UPDATE evidence SET submission=3').run();
  initial.close();

  const databasePath = path.join(env.run, 'ledger.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    ALTER TABLE evidence RENAME TO evidence_with_submission;
    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY, fact_id INTEGER NOT NULL REFERENCES facts(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id), ${hasSubmission ? 'submission INTEGER NOT NULL DEFAULT 1,' : ''} sha256 TEXT NOT NULL,
      source TEXT NOT NULL, note TEXT NOT NULL, bytes INTEGER NOT NULL,
      UNIQUE(fact_id, task_id, ${hasSubmission ? 'submission,' : ''} sha256, note)
    );
    INSERT INTO evidence(id,fact_id,task_id,${hasSubmission ? 'submission,' : ''}sha256,source,note,bytes)
      SELECT id,fact_id,task_id,${hasSubmission ? 'submission,' : ''}sha256,source,note,bytes FROM evidence_with_submission;
    DROP TABLE evidence_with_submission;
  `);
  legacy.close();

  const migrated = new Store(env.run); env.dispose(() => migrated.close());
  assert(migrated.db.prepare('PRAGMA table_info(evidence)').all().some(column => column.name === 'submission'));
  assert.deepEqual(migrated.fact(ids[0]).evidence.map(item => item.submission), [hasSubmission ? 3 : 1]);
  assert.equal(migrated.evidenceStatus().facts[ids[0]], true);
  const uniqueIndex = migrated.db.prepare('PRAGMA index_list(evidence)').all().find(index => index.unique);
  const columns = migrated.db.prepare(`PRAGMA index_info('${uniqueIndex.name}')`).all().map(column => column.name);
  assert.deepEqual(columns, ['fact_id', 'task_id', 'submission', 'source', 'sha256', 'note']);
});
}

test('failed dependencies become blocked and exact duplicate tasks are not queued', t => {
  const { store } = setup(t);
  const one = store.addTask(task('One'));
  assert.equal(store.addTask(task('One')), null);
  const two = store.addTask(task('Two'), { dependencies: [one] });
  store.updateTask(one, { state: 'stalled' });
  assert.deepEqual(store.readyTasks(), []);
  assert.equal(store.task(two).state, 'blocked');
});

test('instructions persist through another WAL connection without losing Unicode/newlines', t => {
  const { store, run, dispose } = setup(t);
  const other = new Store(run); dispose(() => other.close());
  const text = '추가 지시\n여러 줄과 "인용", $(), `backticks`를 그대로 보관합니다.';
  const id = other.message(text);
  assert.equal(store.messages(null)[0].text, text);
  const attempt = store.beginAttempt(null, 'planner', 'codex');
  assert.equal(store.pendingMessages(attempt, null)[0].id, id);
  store.delivered(id, attempt, 'accepted');
  assert.equal(store.pendingMessages(attempt, null).length, 0);
});

test('semantic aliases can be superseded without refuting a supported observation', t => {
  const { store, workspace, directory } = setup(t);
  const one = store.addTask(task('First')), two = store.addTask(task('Second'));
  const first = store.submitWorker(one, workerResult(workspace), directory, workspace);
  store.applyVerdict(one, verdict(first), first);
  const second = store.submitWorker(two, workerResult(workspace, 'The minimum documented runtime is Node.js version 24.'), directory, workspace);
  store.applyVerdict(two, verdict(second), second);
  const conflict = store.addTask(task('Alias review'), { kind: 'conflict' });
  store.applyVerdict(conflict, { decision: 'accept', reason: 'Equivalent meanings', fact_verdicts: [
    { id: first[0], state: 'verified', reason: 'Canonical supported observation' },
    { id: second[0], state: 'superseded', reason: 'Equivalent wording' },
  ] }, [...first, ...second]);
  assert.equal(store.fact(second[0]).state, 'superseded');
  assert.match(store.fact(second[0]).reason, new RegExp('canonical F' + first[0]));
  assert.equal(store.fact(first[0]).state, 'verified');
});
