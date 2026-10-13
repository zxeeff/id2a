import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { readText } from '../src/util.mjs';
import { fixture, task, workerResult, verdict, scriptedFactory, defaultResult } from './helpers.mjs';

test('controller publishes derived files before resolving relative evidence', t => {
  const env = fixture(t);
  const store = new Store(env.run); env.dispose(() => store.close());
  const directory = path.join(env.run, 'work'); fs.mkdirSync(directory);
  const id = store.addTask(task());
  const result = workerResult(env.workspace, 'The derived report contains the Node.js requirement.');
  result.artifacts = [{ path: 'nested/요약.txt', content: 'Node.js 24 이상\n문서 기반 결과\n' }];
  result.facts[0].evidence[0].path = 'outputs/nested/요약.txt';
  const ids = store.submitWorker(id, result, directory, env.workspace);
  assert.equal(readText(path.join(directory, 'outputs', 'nested', '요약.txt')), result.artifacts[0].content);
  assert.equal(readText(store.fact(ids[0]).evidence[0].artifact), result.artifacts[0].content);
  store.applyVerdict(id, verdict(ids), ids);
});

test('goal context exposes declared output paths and verified file hashes', t => {
  const env = fixture(t);
  const engine = new Engine(env.run); env.dispose(() => engine.close());
  const directory = path.join(env.run, 'tasks', 'T1'); fs.mkdirSync(directory, { recursive: true });
  const id = engine.store.addTask(task());
  const result = workerResult(env.workspace);
  result.artifacts = [{ path: 'summary.txt', content: 'Node.js 24 or newer.\n' }];
  const ids = engine.store.submitWorker(id, result, directory, env.workspace);
  engine.store.applyVerdict(id, verdict(ids), ids);
  engine.store.updateTask(id, { state: 'accepted' });
  const artifact = engine.goalContext().compactTasks[0].result.artifacts[0];
  assert.equal(artifact.path, path.join(directory, 'outputs', 'summary.txt'));
  assert.equal(artifact.exists, true);
  assert.equal(artifact.expected_sha256, artifact.actual_sha256);
});

test('derived output cannot escape its directory or follow a junction outside it', t => {
  const env = fixture(t);
  const store = new Store(env.run); env.dispose(() => store.close());
  const directory = path.join(env.run, 'work'); fs.mkdirSync(directory);
  assert.throws(() => store.writeDerivedArtifacts([{ path: '../../outside.txt', content: 'x' }], directory), /출력 경로/u);
  assert.throws(() => store.writeDerivedArtifacts([{ path: 'C:\\outside.txt', content: 'x' }], directory), /출력 경로/u);
  assert.throws(() => store.writeDerivedArtifacts([{ path: 'nul.txt', content: 'x' }], directory), /출력 경로/u);
  fs.symlinkSync(env.workspace, path.join(directory, 'outputs', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.writeDerivedArtifacts([{ path: 'link/notes.txt', content: 'overwrite' }], directory), /링크/u);
  assert.match(readText(path.join(env.workspace, 'notes.txt')), /Node.js 24/u);
});

test('targeted instructions reopen completed work rather than silently going unused', t => {
  const env = fixture(t);
  const store = new Store(env.run); env.dispose(() => store.close());
  const id = store.addTask(task()); store.updateTask(id, { state: 'accepted' });
  store.message('설치 조건도 함께 확인해줘', String(id));
  assert.equal(store.task(id).state, 'queued');
  assert.equal(store.messages(id)[0].text, '설치 조건도 함께 확인해줘');
});

test('new tasks added during final editing are executed before completion', async t => {
  const env = fixture(t);
  let editors = 0, engine;
  engine = new Engine(env.run, { providerFactory: scriptedFactory(message => {
    if (message.role === 'worker') return workerResult(env.workspace);
    if (message.role === 'editor' && ++editors === 1) {
      assert.equal(engine.store.getMeta('goal:outcome'), 'pending');
      engine.store.addTask(task('User added task'));
    }
    return defaultResult(message);
  }) }); env.dispose(() => engine.close());
  assert.equal(await engine.run(), 'completed');
  assert.equal(editors, 2);
  assert.equal(engine.store.tasks().length, 2);
  assert(engine.store.tasks().every(item => item.state === 'accepted'));
  assert.equal(engine.store.getMeta('goal:outcome'), 'achieved');
  assert.equal(engine.store.events().filter(event => event.type === 'run.finished').length, 1);
});
