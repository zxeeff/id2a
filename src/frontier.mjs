import { hash, normalize, now } from './util.mjs';
import { schemas, validate } from './schemas.mjs';

const pending = new Set(['queued', 'running', 'reviewing']);
export const taskIdentity = task => hash(normalize(`${task.title}\n${task.brief}\n${task.scope}`).toLowerCase());

export function resourcesFor(task, review = false) {
  const resources = review ? { workspace: 'read', cpu: 1 } : task.resources || { workspace: 'write', cpu: 1 };
  validate(resources, schemas.refill.properties.tasks.items.properties.resources);
  if (resources.cpu < 1 || resources.cpu > 1024) throw new Error('Task CPU weight must be 1..1024.');
  return resources;
}

export function validateTaskClaims(task, cpuCapacity = 1024) {
  if (![task.title, task.brief, task.scope].every(value => value.trim())) throw new Error('Task title, brief and scope must be nonempty.');
  if (task.logical_key !== undefined && (!task.logical_key.trim() || task.logical_key.length > 240)) throw new Error('Invalid task logical key.');
  const resources = resourcesFor(task);
  if (resources.cpu > cpuCapacity) throw new Error('Task CPU weight exceeds configured capacity.');
  return resources;
}

export function compatible(claim, occupied, capacity) {
  return claim.cpu + occupied.reduce((sum, item) => sum + item.cpu, 0) <= capacity
    && occupied.every(item => claim.workspace === 'none' || item.workspace === 'none'
      || (claim.workspace === 'read' && item.workspace === 'read'));
}

export function graphProblems(tasks) {
  const byID = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set(), visited = new Set(), invalid = new Set();
  const visit = id => {
    if (visiting.has(id)) { for (const member of visiting) invalid.add(member); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byID.get(id).dependencies) {
      if (!byID.has(dependency)) invalid.add(id);
      else visit(dependency);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return invalid;
}

// These fingerprints contain inputs, never attempt/event timestamps. Polling
// and provider logs cannot wake a decision; task state transitions can.
export function frontierSnapshot(store) {
  const view = store.ledgerData();
  const messages = store.db.prepare('SELECT id,target,text FROM messages ORDER BY id').all();
  const components = {
    graph: hash(JSON.stringify(view.tasks)),
    knowledge: hash(JSON.stringify({ facts: view.facts, digests: view.digests })),
    instructions: hash(JSON.stringify(messages)),
    contract: hash(JSON.stringify(store.getMeta('goal:contract'))),
    config: hash(JSON.stringify(store.getMeta('config'))),
    source: hash(JSON.stringify(store.getMeta('source:current'))),
  };
  return { ...components, key: hash(JSON.stringify(components)) };
}

export function decisionAwake(decision, snapshot, tasks) {
  if (!decision) return true;
  const before = decision.snapshot;
  if (before.contract !== snapshot.contract || before.instructions !== snapshot.instructions
      || before.config !== snapshot.config) return true;
  if (decision.status !== 'DEFERRED') return before.key !== snapshot.key;
  switch (decision.wake.kind) {
    case 'task_settled': return decision.wake.task_ids.some(id => !pending.has(tasks.find(task => task.id === id)?.state));
    case 'knowledge_changed': return before.knowledge !== snapshot.knowledge;
    case 'graph_changed': return before.graph !== snapshot.graph;
    case 'instruction_changed': return false;
    default: return false;
  }
}

export function validateRefill(result, tasks, limit, cpuCapacity) {
  validate(result, schemas.refill);
  if (!result.summary.trim()) throw new Error('Refill needs a concrete summary or waiting reason.');
  if (result.tasks.length > limit) throw new Error('Refill exceeds the available frontier capacity.');
  if ((result.status === 'READY') !== Boolean(result.tasks.length)) throw new Error('READY requires work; EXHAUSTED/DEFERRED require zero tasks.');
  if (result.status === 'DEFERRED') {
    if (result.wake.kind === 'none') throw new Error('DEFERRED requires a concrete wake condition.');
    if (result.wake.kind === 'task_settled' && (!result.wake.task_ids.length
        || result.wake.task_ids.some(id => !tasks.some(task => task.id === id && pending.has(task.state))))) {
      throw new Error('task_settled must name current unfinished tasks.');
    }
  } else if (result.wake.kind !== 'none') throw new Error('Only DEFERRED may specify a wake condition.');
  if (result.wake.kind !== 'task_settled' && result.wake.task_ids.length) throw new Error('Unexpected wake task IDs.');
  for (const [index, task] of result.tasks.entries()) {
    validateTaskClaims(task, cpuCapacity);
    if (task.depends_on.some(id => id < 0 || id >= index)) throw new Error('Refill dependencies must reference earlier proposal indexes.');
    if (task.existing_dependencies.some(id => !tasks.some(existing => existing.id === id))) throw new Error('Unknown existing task dependency.');
  }
}

// One transaction owns the snapshot CAS, inserts, dedup aliases and receipt.
// Existing tasks are never rewritten to attach a new dependency (cycle safety).
export function admitRefill(store, request, result, { epoch, cpuCapacity }) {
  const committed = store.transaction(() => {
    const previous = store.getMeta('frontier:receipt:' + request.id);
    if (previous) return { ...previous, replayed: true };
    const state = store.getMeta('frontier:state');
    if (store.getMeta('control') !== 'running' || (store.getMeta('control:epoch', 0) || 0) !== epoch
        || (store.getMeta('control:revision', 0) || 0) !== (request.controlRevision || 0)
        || store.getMeta('control:lease') !== epoch || state?.phase !== 'RUNNING'
        || store.getMeta('frontier:request')?.id !== request.id
        || frontierSnapshot(store).key !== request.snapshot.key) return { stale: true, admitted: [] };
    const tasks = store.tasks();
    validateRefill(result, tasks, request.limit, cpuCapacity);
    const ids = [], admitted = [], duplicates = [];
    for (const task of result.tasks) {
      const identity = taskIdentity(task);
      const existing = store.existingTask(task);
      const same = existing ? tasks.find(prior => prior.id === existing) : tasks.find(prior => taskIdentity(prior) === identity);
      if (same) {
        store.aliasTask(task.logical_key, same.id);
        ids.push(same.id); duplicates.push(same.id); continue;
      }
      const dependencies = [...new Set([...task.existing_dependencies, ...task.depends_on.map(index => ids[index])])];
      const inserted = store.db.prepare('INSERT INTO tasks(title,brief,scope,signature,dependencies,resources,logical_key,created) VALUES (?,?,?,?,?,?,?,?)')
        .run(task.title, task.brief, task.scope, identity, JSON.stringify(dependencies), JSON.stringify(task.resources), task.logical_key, now());
      const id = Number(inserted.lastInsertRowid);
      store.aliasTask(task.logical_key, id);
      ids.push(id); admitted.push(id);
      tasks.push({ ...task, id, dependencies, state: 'queued' });
    }
    const receipt = { admitted, duplicates, status: result.status, at: now() };
    store.setMeta('frontier:receipt:' + request.id, receipt);
    store.setMeta('frontier:decision', { ...result, tasks: undefined, snapshot: frontierSnapshot(store) });
    store.setMeta('frontier:request', null);
    return receipt;
  });
  if (!committed.replayed) for (const id of committed.admitted) store.event('task.queued', { task: id, title: store.task(id).title, kind: 'work', origin: 'refill' });
  return committed;
}
