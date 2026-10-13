import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRun, listRuns, resolveRun } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function runFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'id2a-run-selection-'));
  const runs = path.join(root, 'runs');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const workspaceEmpty = path.join(root, 'workspace-empty');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  fs.mkdirSync(workspaceEmpty);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const addRun = (workspace, id, state) => {
    const created = createRun({ workspace }, `Goal for ${id}`, runs);
    const directory = path.join(runs, id);
    fs.renameSync(created, directory);
    const store = new Store(directory);
    try { store.setMeta('state', state); }
    finally { store.close(); }
    return directory;
  };

  const oldA = addRun(workspaceA, '2026-01-01T00-00-00-000-aaaaaaaa', 'old-a');
  const latestA = addRun(workspaceA, '2026-01-02T00-00-00-000-aaaaaaaa', 'latest-a');
  const latestGlobal = addRun(workspaceB, '2026-01-03T00-00-00-000-bbbbbbbb', 'latest-global');
  return { runs, workspaceA, workspaceB, workspaceEmpty, oldA, latestA, latestGlobal };
}

function invoke(args, cwd) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
}

test('latest and list are scoped to the selected workspace unless global is requested', t => {
  const env = runFixture(t);
  assert.deepEqual(listRuns(env.runs, { workspace: env.workspaceA }).map(run => run.directory), [env.latestA, env.oldA]);
  assert.equal(resolveRun('latest', env.runs, { workspace: env.workspaceA }), env.latestA);
  assert.equal(resolveRun('latest', env.runs, { workspace: env.workspaceA, global: true }), env.latestGlobal);
  assert.equal(resolveRun(path.basename(env.latestGlobal), env.runs, { workspace: env.workspaceA }), env.latestGlobal);
  assert.throws(() => resolveRun('latest', env.runs, { workspace: env.workspaceEmpty }), /--global/u);
});

test('CLI scopes list and latest commands to cwd while --global and explicit IDs bypass the scope', t => {
  const env = runFixture(t);
  const localList = invoke(['list', '--runs-root', env.runs], env.workspaceA);
  assert.equal(localList.status, 0, localList.stderr);
  assert.match(localList.stdout, /2026-01-02T00-00-00-000-aaaaaaaa/u);
  assert.doesNotMatch(localList.stdout, /2026-01-03T00-00-00-000-bbbbbbbb/u);

  const globalList = invoke(['list', '--runs-root', env.runs, '--global'], env.workspaceA);
  assert.equal(globalList.status, 0, globalList.stderr);
  assert.match(globalList.stdout, /2026-01-03T00-00-00-000-bbbbbbbb/u);

  const localStatus = invoke(['status', 'latest', '--runs-root', env.runs, '--json'], env.workspaceA);
  assert.equal(localStatus.status, 0, localStatus.stderr);
  const localStatusJSON = JSON.parse(localStatus.stdout);
  assert.equal(localStatusJSON.state, 'latest-a');
  assert.equal(localStatusJSON.format_version, 3);
  assert.equal(localStatusJSON.goal_format_version, 1);

  const globalStatus = invoke(['status', 'latest', '--runs-root', env.runs, '--global', '--json'], env.workspaceA);
  assert.equal(globalStatus.status, 0, globalStatus.stderr);
  assert.equal(JSON.parse(globalStatus.stdout).state, 'latest-global');

  const explicitStatus = invoke(['status', path.basename(env.latestGlobal), '--runs-root', env.runs, '--json'], env.workspaceA);
  assert.equal(explicitStatus.status, 0, explicitStatus.stderr);
  assert.equal(JSON.parse(explicitStatus.stdout).state, 'latest-global');

  const missing = invoke(['status', 'latest', '--runs-root', env.runs], env.workspaceEmpty);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--global/u);
});

test('legacy completed runs are not inferred to have achieved their goal', t => {
  const env = runFixture(t);
  const store = new Store(env.latestA);
  try {
    store.setMeta('state', 'completed');
    store.db.prepare("DELETE FROM meta WHERE key IN ('goal:format_version','goal:outcome','run:termination','report:status')").run();
    const completion = store.completionStatus();
    assert.equal(completion.format_version, 3);
    assert.equal(completion.goal_format_version, 0);
    assert.equal(completion.execution_state, 'completed');
    assert.equal(completion.goal_outcome, 'legacy_unknown');
    assert.equal(completion.termination.reason, 'legacy_unknown');
  } finally { store.close(); }
});

test('legacy run.finished events render explicit unknown goal fields', t => {
  const env = runFixture(t);
  const store = new Store(env.latestA);
  try { store.event('run.finished', { state: 'completed', report: 'legacy-report.md' }); }
  finally { store.close(); }
  const logs = invoke(['logs', path.basename(env.latestA), '--runs-root', env.runs], env.workspaceA);
  assert.equal(logs.status, 0, logs.stderr);
  assert.match(logs.stdout, /legacy_unknown/u);
  assert.match(logs.stdout, /legacy-report\.md/u);
});
