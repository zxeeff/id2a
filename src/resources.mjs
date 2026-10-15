import { compatible, resourcesFor } from './frontier.mjs';
import { now } from './util.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Reservations have no TTL. Only a settled session with a confirmed process
// close (or a dead recorded PID on recovery) can release shared-workspace use.
export class Resources {
  constructor(store) { this.store = store; this.held = new Map(); }
  save() { this.store.setMeta('scheduler:reservations', [...this.held.values()]); }
  recover() {
    for (const item of this.store.getMeta('scheduler:reservations', [])) {
      if ((item.process_state === 'running' && alive(item.pid)) || item.process_state === 'starting') {
        throw new Error(`Workspace reservation for T${item.task} is still unresolved (provider PID ${item.pid || 'unknown'}). Confirm that its provider and tools have stopped before resuming; reservations do not expire.`);
      }
    }
    this.save();
  }
  occupied() { return [...this.held.values()]; }
  canRun(task, review, capacity) { return compatible(resourcesFor(task, review), this.occupied(), capacity); }
  reserve(task, review, capacity) {
    return this.reserveClaim(task.id, resourcesFor(task, review), review, capacity);
  }
  reserveCoordinator(id, capacity) {
    // A ledger-only coordinator has no workspace claim, but still consumes one
    // unit of the provider/CPU budget and needs durable process recovery.
    return this.reserveClaim(id, { workspace: 'none', cpu: 1 }, false, capacity);
  }
  reserveClaim(id, claim, review, capacity) {
    if (this.held.has(id) || !compatible(claim, this.occupied(), capacity)) return false;
    this.held.set(id, { task: id, ...claim, review,
      controller_pid: process.pid, pid: null, process_state: 'idle', acquired_at: now() });
    this.save(); return true;
  }
  process(taskID, state, pid = null) {
    const item = this.held.get(taskID);
    if (!item) return;
    item.process_state = state;
    item.pid = pid;
    this.save();
  }
  release(taskID) {
    const item = this.held.get(taskID);
    if (!item) return;
    if (item.process_state === 'starting' || item.process_state === 'running') {
      // Keep the reservation durable even when a broken provider rejects early.
      this.store.event('scheduler.reservation_held', { task: taskID, pid: item.pid, reason: 'process_not_confirmed_stopped' });
      return false;
    }
    this.held.delete(taskID); this.save(); return true;
  }
}
