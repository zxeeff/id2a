import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

export const VERSION = '0.3.0';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const now = () => new Date().toISOString();
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const normalize = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export const readText = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
export const readJSON = file => JSON.parse(readText(file));
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
export function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function integer(value, label, minimum = 1, maximum = 1000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}: ${minimum}..${maximum} 사이 정수가 필요합니다.`);
  }
  return number;
}
export function sourceIdentity(workspace) {
  const result = { path: fs.realpathSync(workspace), revision: null, dirty: null };
  try {
    result.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    result.dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* A workspace need not be a git repository. */ }
  return result;
}

// Resolve npm wrappers to their real executable. No shell receives user text.
export function resolveCLI(name, override) {
  if (override) {
    const executable = path.resolve(override);
    if (!fs.existsSync(executable)) throw new Error(`실행 파일 없음: ${executable}`);
    if (/\.(?:mjs|cjs|js)$/iu.test(executable)) return { command: process.execPath, args: [executable] };
    if (/\.(?:cmd|bat|ps1)$/iu.test(executable)) return resolveWrapper(executable, name);
    return { command: executable, args: [] };
  }
  const directories = (process.env.PATH || '').split(path.delimiter);
  for (const directory of directories) {
    const clean = directory.replace(/^"|"$/gu, '');
    for (const extension of process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']) {
      const file = path.join(clean, name + extension);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return extension === '.exe' || extension === '' ? { command: file, args: [] } : resolveWrapper(file, name);
      }
    }
  }
  throw new Error(`${name} CLI를 PATH에서 찾을 수 없습니다. --${name}-bin으로 실행 파일을 지정하세요.`);
}
function resolveWrapper(wrapper, name) {
  const directory = path.dirname(wrapper);
  const candidates = name === 'codex'
    ? [
      ['node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'],
      ['node_modules', '@openai', 'codex', 'bin', 'codex.js'],
    ]
    : [['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'], ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js']];
  for (const parts of candidates) {
    const file = path.join(directory, ...parts);
    if (fs.existsSync(file)) return /\.exe$/iu.test(file) ? { command: file, args: [] } : { command: process.execPath, args: [file] };
  }
  throw new Error(`${wrapper}의 실행 파일을 찾지 못했습니다. --${name}-bin으로 실제 .exe 또는 .js를 지정하세요.`);
}
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('close', resolve));
  child.stdin.end();
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); }
      catch { child.kill(); }
    } else child.kill('SIGTERM');
  }, 1000);
  await exited;
  clearTimeout(timer);
}
export function spawnCLI(name, args, options = {}) {
  const executable = resolveCLI(name, options.bin);
  return spawn(executable.command, [...executable.args, ...args], {
    cwd: options.cwd, env: { ...process.env, ...options.env }, windowsHide: true,
    shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function acquireLock(directory) {
  const file = path.join(directory, 'controller.lock');
  if (fs.existsSync(file)) {
    const owner = readJSON(file);
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`이미 실행 중인 컨트롤러가 있습니다 (PID ${owner.pid}). send/status/logs 명령을 사용하세요.`);
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, created: now() }), { flag: 'wx' });
  return () => {
    if (fs.existsSync(file) && readJSON(file).pid === process.pid) fs.unlinkSync(file);
  };
}

export function boundedJSON(items, characters) {
  const selected = [];
  let used = 2;
  for (const item of items) {
    const size = JSON.stringify(item).length + (selected.length ? 1 : 0);
    if (size + used > characters) continue;
    selected.push(item);
    used += size;
  }
  return { items: selected, total: items.length, included: selected.length, truncated: selected.length < items.length };
}
