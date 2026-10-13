import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRun } from '../src/engine.mjs';
import { readText, within } from '../src/util.mjs';

export function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'id2a-test-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Node.js 24 or newer.\nTests use npm test.\n', 'utf8');
  const run = createRun({ workspace, ...config }, '문서의 실행 환경을 확인하세요.', path.join(root, 'runs'));
  const disposers = [];
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose();
    assert(within(fs.realpathSync(os.tmpdir()), fs.realpathSync(root)) && path.basename(root).startsWith('id2a-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, run, dispose: callback => disposers.push(callback) };
}
export const task = (title = 'Check version') => ({ title, brief: 'Read notes.txt and check the runtime version.', scope: 'docs.runtime' });
export function workerResult(workspace, claim = 'Node.js 24 or newer is required.', key = 'docs.runtime.node') {
  return { summary: 'Read the project notes.', artifacts: [], facts: [{ key, scope: 'docs.runtime', kind: 'observation', claim,
    evidence: [{ path: path.join(workspace, 'notes.txt'), note: 'Line 1' }] }], followups: [] };
}
export const verdict = (ids, state = 'verified', decision = 'accept') => ({ decision, reason: 'Compared the evidence file with the exact claim.',
  fact_verdicts: ids.map(id => ({ id, state, reason: 'The evidence supports this claim.' })) });
export function scriptedFactory(handler) {
  return (provider, options) => ({
    done: false,
    async steer(text) { return handler({ role: 'steer', text, provider, options }) || 'accepted'; },
    async run(request) {
      const role = /^Role: (\w+)/mu.exec(request.prompt)[1];
      const data = JSON.parse(request.prompt.split('Assigned data (JSON):\n')[1]);
      options.onSession?.(request.sessionID || 'fixture-' + role);
      return await handler({ role, data, request, provider, options });
    },
  });
}
export function defaultResult({ role, data }) {
  if (role === 'planner') return { summary: 'Check notes', tasks: [{ ...task(), depends_on: [] }] };
  if (role === 'worker') throw new Error('Worker fixture needs an explicit workspace.');
  if (role === 'supervisor') {
    for (const fact of data.facts) assert(readText(fact.evidence[0].artifact).includes('Node.js 24'));
    return verdict(data.facts.map(fact => fact.id));
  }
  if (role === 'goal') return {
    decision: 'complete',
    reason: 'All requested work is accepted and independently verified.',
    progress: 'The requested project result is present.',
    fact_ids: data.facts.map(fact => fact.id),
    next_tasks: [],
    question: '',
  };
  if (role === 'curator') return { scope: 'docs.runtime', summary: 'The notes require Node.js 24 or newer.', fact_ids: data.facts.map(fact => fact.id) };
  if (role === 'editor') return { title: 'Result', body: 'See confirmed facts.', fact_ids: data.facts.map(fact => fact.id) };
  if (role === 'triage') return { decision: 'approve', reason: 'Necessary followup' };
  throw new Error('Unexpected fixture role: ' + role);
}
