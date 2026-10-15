import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { CodexSession, ClaudeSession } from '../src/providers.mjs';
import { Engine } from '../src/engine.mjs';
import { sleep } from '../src/util.mjs';
import { fixture } from './helpers.mjs';

const binary = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };

test('Codex app-server accepts a large Unicode prompt and real turn steering', async t => {
  const { workspace } = fixture(t);
  const session = new CodexSession({ cwd: workspace, bin: binary });
  const running = session.run({ prompt: '긴 프롬프트\n'.repeat(20000), schema, effort: 'low' });
  while (!session.turnID) await sleep(10);
  assert.equal(await session.steer('updated'), 'accepted');
  assert.deepEqual(await running, { value: 'updated' });
});

test('Claude keeps queued instructions until their replacement result arrives', async t => {
  const { workspace } = fixture(t);
  const session = new ClaudeSession({ cwd: workspace, bin: binary });
  const running = session.run({ prompt: 'initial', schema, effort: 'low' });
  assert.equal(await session.steer('updated'), 'queued');
  assert.deepEqual(await running, { value: 'updated' });
  assert.equal(session.received, 2);
});

test('yolo reaches native unrestricted modes even for independent review roles', async t => {
  const { workspace } = fixture(t);
  const codex = new CodexSession({ cwd: workspace, bin: binary });
  assert.deepEqual(await codex.run({ prompt: '[sandbox]', schema, effort: 'low', permissions: 'yolo', readOnly: true }), { value: 'danger-full-access' });
  const claude = new ClaudeSession({ cwd: workspace, bin: binary });
  assert.deepEqual(await claude.run({ prompt: '[permissions]', schema, effort: 'low', permissions: 'yolo', readOnly: true }), { value: 'yolo-unrestricted' });
});

test('Codex rejects failed turns, malformed JSON, and unsupported effort', async t => {
  const { workspace } = fixture(t);
  for (const [prompt, effort, expected] of [['[fail]', 'low', /fixture failed/u], ['[invalid]', 'low', /JSON 오류/u], ['initial', 'ultra', /미지원/u]]) {
    const session = new CodexSession({ cwd: workspace, bin: binary });
    await assert.rejects(session.run({ prompt, schema, effort }), expected);
  }
});

test('cancellation rejects an active provider and closes its subprocess', async t => {
  const { workspace } = fixture(t);
  const session = new CodexSession({ cwd: workspace, bin: binary });
  const abort = new AbortController();
  const running = session.run({ prompt: 'initial', schema, signal: abort.signal });
  while (!session.turnID) await sleep(10);
  abort.abort();
  await assert.rejects(running, /중단/u);
  assert.notEqual(session.protocol.child.exitCode, null);
});

test('provider turns ignore legacy wall-clock timeout options', async t => {
  const { workspace } = fixture(t);
  const codex = new CodexSession({ cwd: workspace, bin: binary, timeout: 0.05 });
  assert.deepEqual(await codex.run({ prompt: 'initial', schema, effort: 'low' }), { value: 'initial' });
  const claude = new ClaudeSession({ cwd: workspace, bin: binary, timeout: 0.05 });
  assert.deepEqual(await claude.run({ prompt: 'initial', schema, effort: 'low' }), { value: 'initial' });
});

test('switching providers does not forward an incompatible model or effort', t => {
  const { run, dispose } = fixture(t, { model: 'gpt-example', effort: 'ultra', roleSettings: { supervisor: { provider: 'claude' } } });
  const engine = new Engine(run); dispose(() => engine.close());
  assert.equal(engine.settings('worker').model, 'gpt-example');
  assert.equal(engine.settings('supervisor').model, null);
  assert.equal(engine.settings('supervisor').effort, 'auto');
});

test('a provider exit does not release reservations before its stdio close is confirmed', async t => {
  const { workspace } = fixture(t);
  const states = [];
  const session = new CodexSession({ cwd: workspace, bin: binary,
    onProcess: state => states.push(state) });
  const open = session.open.bind(session);
  let observedExit = false;
  session.open = async () => {
    const result = await open();
    const child = session.protocol.child;
    const emit = child.emit.bind(child);
    // Deterministically model stdio closing after process exit, across platforms.
    child.emit = (event, ...args) => {
      if (event === 'close') { setTimeout(() => emit(event, ...args), 100); return true; }
      return emit(event, ...args);
    };
    const close = session.protocol.close.bind(session.protocol);
    session.protocol.close = async () => {
      if (child.exitCode === null) await once(child, 'exit');
      observedExit = true;
      assert.deepEqual(states, ['running']);
      await close();
    };
    return result;
  };
  let closed = false;
  const running = session.run({ prompt: '[exit-before-close]', schema });
  while (!session.protocol) await sleep(10);
  session.protocol.child.once('close', () => { closed = true; });
  assert.deepEqual(await running, { value: 'initial' });
  assert(observedExit); assert(closed);
  assert.deepEqual(states, ['running', 'stopped']);
});
