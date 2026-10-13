import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexSession, ClaudeSession } from '../src/providers.mjs';
import { Engine } from '../src/engine.mjs';
import { sleep } from '../src/util.mjs';
import { fixture } from './helpers.mjs';

const binary = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };

test('Codex app-server accepts a large Unicode prompt and real turn steering', async t => {
  const { workspace } = fixture(t);
  const session = new CodexSession({ cwd: workspace, bin: binary, timeout: 5 });
  const running = session.run({ prompt: '긴 프롬프트\n'.repeat(20000), schema, effort: 'low' });
  while (!session.turnID) await sleep(10);
  assert.equal(await session.steer('updated'), 'accepted');
  assert.deepEqual(await running, { value: 'updated' });
});

test('Claude keeps queued instructions until their replacement result arrives', async t => {
  const { workspace } = fixture(t);
  const session = new ClaudeSession({ cwd: workspace, bin: binary, timeout: 5 });
  const running = session.run({ prompt: 'initial', schema, effort: 'low' });
  assert.equal(await session.steer('updated'), 'queued');
  assert.deepEqual(await running, { value: 'updated' });
  assert.equal(session.received, 2);
});

test('yolo reaches native unrestricted modes even for independent review roles', async t => {
  const { workspace } = fixture(t);
  const codex = new CodexSession({ cwd: workspace, bin: binary, timeout: 5 });
  assert.deepEqual(await codex.run({ prompt: '[sandbox]', schema, effort: 'low', permissions: 'yolo', readOnly: true }), { value: 'danger-full-access' });
  const claude = new ClaudeSession({ cwd: workspace, bin: binary, timeout: 5 });
  assert.deepEqual(await claude.run({ prompt: '[permissions]', schema, effort: 'low', permissions: 'yolo', readOnly: true }), { value: 'yolo-unrestricted' });
});

test('Codex rejects failed turns, malformed JSON, and unsupported effort', async t => {
  const { workspace } = fixture(t);
  for (const [prompt, effort, expected] of [['[fail]', 'low', /fixture failed/u], ['[invalid]', 'low', /JSON 오류/u], ['initial', 'ultra', /미지원/u]]) {
    const session = new CodexSession({ cwd: workspace, bin: binary, timeout: 5 });
    await assert.rejects(session.run({ prompt, schema, effort }), expected);
  }
});

test('cancellation rejects an active provider and closes its subprocess', async t => {
  const { workspace } = fixture(t);
  const session = new CodexSession({ cwd: workspace, bin: binary, timeout: 5 });
  const abort = new AbortController();
  const running = session.run({ prompt: 'initial', schema, signal: abort.signal });
  while (!session.turnID) await sleep(10);
  abort.abort();
  await assert.rejects(running, /중단/u);
  assert.notEqual(session.protocol.child.exitCode, null);
});

test('switching providers does not forward an incompatible model or effort', t => {
  const { run, dispose } = fixture(t, { model: 'gpt-example', effort: 'ultra', roleSettings: { supervisor: { provider: 'claude' } } });
  const engine = new Engine(run); dispose(() => engine.close());
  assert.equal(engine.settings('worker').model, 'gpt-example');
  assert.equal(engine.settings('supervisor').model, null);
  assert.equal(engine.settings('supervisor').effort, 'auto');
});
