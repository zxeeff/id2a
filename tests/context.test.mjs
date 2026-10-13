import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { boundedJSON, hash } from '../src/util.mjs';
import { fixture, task, workerResult, verdict, scriptedFactory, defaultResult } from './helpers.mjs';

function seed(store, env, count, length = 100, scope = 'docs.runtime') {
  const id = store.addTask({ ...task('Batch ' + scope), scope });
  const directory = path.join(env.run, 'tasks', 'T' + id);
  fs.mkdirSync(directory, { recursive: true });
  const result = workerResult(env.workspace);
  result.facts = Array.from({ length: count }, (_, index) => ({ ...result.facts[0], scope,
    key: scope + '.item' + index, claim: 'Observation ' + index + ': ' + 'x'.repeat(length) }));
  const ids = store.submitWorker(id, result, directory, env.workspace);
  store.applyVerdict(id, verdict(ids), ids);
  store.updateTask(id, { state: 'accepted' });
  return ids;
}

test('bounded selection reports omitted oversized records and exact totals', () => {
  const pack = boundedJSON([{ id: 1, text: 'x'.repeat(1000) }, { id: 2 }], 20);
  assert.deepEqual(pack, { items: [{ id: 2 }], total: 2, included: 1, truncated: true });
  assert.deepEqual(boundedJSON([], 20), { items: [], total: 0, included: 0, truncated: false });
  assert.equal(boundedJSON([{ id: 1 }], JSON.stringify([{ id: 1 }]).length).included, 1);
});

test('curation ignores legacy completion markers and drains only delivered batches', async t => {
  const env = fixture(t, { contextCharacters: 2000, curatorBatch: 4 });
  const inputs = [];
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    inputs.push(message.data);
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const ids = seed(engine.store, env, 4, 1400);
  engine.store.setMeta('curated_ids:docs.runtime', ids);
  engine.store.setMeta('curated:docs.runtime', hash(JSON.stringify(ids)));
  await engine.curate(false);
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].context.coverage.facts, { total: 4, included: 1, truncated: true });
  assert.deepEqual(engine.store.curationProgress('docs.runtime').processed_ids, [ids[0]]);
  assert.deepEqual(engine.store.getMeta('curated_ids:docs.runtime'), [ids[0]]);
  await engine.curate(true);
  assert.equal(inputs.length, 4);
  assert.deepEqual(engine.store.curationProgress('docs.runtime').processed_ids, ids);
  assert.deepEqual(engine.store.curationProgress('docs.runtime').indexed_ids, ids);
  await engine.curate(true);
  assert.equal(inputs.length, 4);
});

test('failed curation and rolled-back persistence remain eligible for retry', async t => {
  const env = fixture(t);
  let failures = 1;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (failures-- > 0) throw new Error('injected provider failure');
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  const ids = seed(engine.store, env, 4);
  await engine.curate(true);
  assert.deepEqual(engine.store.curationProgress('docs.runtime'), {
    delivered_ids: ids, processed_ids: [], indexed_ids: [], unindexed_ids: ids,
  });
  const original = engine.store.setMeta.bind(engine.store);
  engine.store.setMeta = (key, value) => {
    if (key.startsWith('curation_batches:')) throw new Error('injected persistence failure');
    original(key, value);
  };
  await engine.curate(true);
  assert.equal(engine.store.ledgerView().digests.length, 0);
  assert.equal(engine.store.events().filter(event => event.type === 'digest.updated').length, 0);
  assert.deepEqual(engine.store.curationProgress('docs.runtime').processed_ids, []);
  engine.store.setMeta = original;
  await engine.curate(true);
  assert.deepEqual(engine.store.curationProgress('docs.runtime').indexed_ids, ids);
});

test('uncited curation inputs stay discoverable and are distinguished from indexed facts', async t => {
  const env = fixture(t);
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => ({
    ...defaultResult(message), fact_ids: [message.data.facts[0].id],
  })) }); env.dispose(() => engine.close());
  const ids = seed(engine.store, env, 4);
  await engine.curate(true);
  const progress = engine.store.curationProgress('docs.runtime');
  assert.deepEqual(progress.processed_ids, ids);
  assert.deepEqual(progress.indexed_ids, [ids[0]]);
  assert.deepEqual(progress.unindexed_ids, ids.slice(1));
  assert.deepEqual(engine.store.ledgerPage({ collection: 'facts' }).items.map(item => item.id), ids);
  const scope = engine.store.ledgerPage({ collection: 'scopes' }).items[0];
  assert.equal(scope.indexed, 1);
  assert.equal(scope.unindexed, 3);
  engine.store.db.prepare("UPDATE facts SET state='refuted' WHERE id=?").run(ids[0]);
  assert.deepEqual(engine.store.curationProgress('docs.runtime').processed_ids, []);
  assert.equal(engine.store.ledgerPage({ collection: 'digests' }).total, 0);
});

test('one curation record larger than the configured budget cannot starve forever', async t => {
  const env = fixture(t, { contextCharacters: 2000 });
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(defaultResult) }); env.dispose(() => engine.close());
  const ids = seed(engine.store, env, 1, 2800);
  await engine.curate(true);
  assert.deepEqual(engine.store.curationProgress('docs.runtime').indexed_ids, ids);
});

test('curation and enumeration do not silently stop at the legacy 500-fact limit', async t => {
  const env = fixture(t);
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(defaultResult) }); env.dispose(() => engine.close());
  const insert = engine.store.db.prepare("INSERT INTO facts(key,scope,kind,claim,claim_hash,state,created) VALUES (?,'docs.runtime','observation',?,?,'verified','2026-01-01')");
  engine.store.transaction(() => {
    for (let index = 0; index < 501; index++) insert.run('docs.runtime.' + index, 'Observation ' + index, hash(String(index)));
  });
  await engine.curate(true);
  assert.equal(engine.store.curationProgress('docs.runtime').indexed_ids.length, 501);
  let offset = 0, snapshot, received = [];
  do {
    const page = engine.store.ledgerPage({ collection: 'facts', snapshot, offset, limit: 50 });
    assert.equal(page.total, 501);
    received.push(...page.items.map(item => item.id));
    snapshot = page.snapshot; offset = page.next_offset;
  } while (offset !== null);
  assert.equal(received.length, 501);
  assert.equal(new Set(received).size, 501);
});

test('pages enumerate contiguous records under size limits and reject a changed snapshot', t => {
  const env = fixture(t);
  const store = new Store(env.run); env.dispose(() => store.close());
  const ids = seed(store, env, 7, 2500);
  const reader = new Store(env.run, { readOnly: true }); env.dispose(() => reader.close());
  const first = reader.ledgerPage({ collection: 'facts', state: 'verified', limit: 50 });
  assert.equal(first.total, 7);
  assert(first.next_offset > 0 && first.next_offset < 7);
  assert.equal(store.ledgerView().snapshot, first.snapshot);
  const second = reader.ledgerPage({ collection: 'facts', state: 'verified', snapshot: first.snapshot, offset: first.next_offset, limit: 50 });
  assert.equal(second.next_offset, null);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), ids);
  assert.throws(() => reader.ledgerPage({ collection: 'facts', offset: 1 }), /snapshot/u);
  assert.throws(() => reader.ledgerPage({ collection: 'facts', offset: -1 }), /offset/u);
  store.db.prepare("UPDATE facts SET state='refuted' WHERE id=?").run(ids[0]);
  assert.throws(() => reader.ledgerPage({ collection: 'facts', snapshot: first.snapshot, offset: first.next_offset }), /변경/u);
  const fresh = reader.ledgerPage({ collection: 'facts', state: 'verified' });
  assert.equal(fresh.total, 6);
  assert.notEqual(fresh.snapshot, first.snapshot);
});

test('scope filtering precedes digest limits, including on an older read-only ledger', t => {
  const env = fixture(t);
  const store = new Store(env.run); env.dispose(() => store.close());
  const own = seed(store, env, 1);
  store.addDigest({ scope: 'docs.runtime', summary: 'Relevant old digest', fact_ids: own });
  for (let index = 0; index < 10; index++) {
    const scope = 'other.scope' + index;
    const ids = seed(store, env, 1, 100, scope);
    store.addDigest({ scope, summary: 'Unrelated digest', fact_ids: ids });
  }
  const reader = new Store(env.run, { readOnly: true }); env.dispose(() => reader.close());
  assert.equal(reader.context(store.task(1)).digests[0].summary, 'Relevant old digest');
  assert.equal(reader.ledgerPage({ collection: 'digests', scope: 'docs.runtime' }).total, 1);
  assert.equal(reader.ledgerPage({ collection: 'scopes', limit: 2 }).total, 11);
});

test('Goal and Editor receive coverage and digests and may cite omitted verified facts', async t => {
  const env = fixture(t, { contextCharacters: 4000 });
  const seen = new Set(); let ids;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    assert(['goal', 'editor'].includes(message.role));
    seen.add(message.role);
    assert.equal(message.data.context.coverage.facts.total, ids.length);
    assert.equal(message.data.context.coverage.facts.truncated, true);
    assert(message.data.context.digests.length > 0);
    assert(message.data.context.scopes.length > 0);
    assert(!message.data.facts.some(fact => fact.id === ids[0]));
    const page = engine.store.ledgerPage({ collection: 'facts', snapshot: message.data.context.snapshot, limit: 1 });
    assert.equal(page.items[0].id, ids[0]);
    return { ...defaultResult(message), fact_ids: [ids[0]] };
  }) }); env.dispose(() => engine.close());
  ids = seed(engine.store, env, 5, 600);
  engine.store.addDigest({ scope: 'docs.runtime', summary: 'Runtime observations', fact_ids: ids });
  const outcome = await engine.assessGoal();
  assert.equal(outcome.kind, 'complete');
  assert.equal(await engine.report(outcome.assessment), 'completed');
  assert.deepEqual([...seen], ['goal', 'editor']);
});

test('Goal rejects invented IDs and discards a decision if fact states change during review', async t => {
  const env = fixture(t);
  let mode = 'invented'; let ids;
  const engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (mode === 'changed') engine.store.db.prepare("UPDATE facts SET state='refuted' WHERE id=?").run(ids[0]);
    return { ...defaultResult(message), fact_ids: mode === 'invented' ? [9999] : [ids[0]] };
  }) }); env.dispose(() => engine.close());
  ids = seed(engine.store, env, 1);
  await assert.rejects(engine.assessGoal(), /검증되지 않은/u);
  mode = 'changed';
  assert.equal((await engine.assessGoal()).kind, 'changed');
  assert.equal(engine.store.getMeta('goal:assessment'), null);
});

test('task coverage exposes omissions and prioritizes work that is not accepted', t => {
  const env = fixture(t, { contextCharacters: 2000 });
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  const pending = engine.store.addTask(task('Pending work'));
  for (let index = 0; index < 8; index++) {
    const id = engine.store.addTask(task('Accepted work ' + index));
    engine.store.updateTask(id, { state: 'accepted' });
  }
  const view = engine.goalContext();
  assert.equal(view.coverage.tasks.total, 9);
  assert.equal(view.coverage.tasks.truncated, true);
  assert(view.compactTasks.some(item => item.id === pending));
  const page = engine.store.ledgerPage({ collection: 'tasks', snapshot: view.snapshot, state: 'queued' });
  assert.deepEqual(page.items.map(item => item.id), [pending]);
});
