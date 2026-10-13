#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { CodexSession } from './providers.mjs';
import { Engine, configuration, createRun, defaultRunsRoot, listRuns, resolveRun, roles } from './engine.mjs';
import { VERSION, integer, readJSON, readText, resolveCLI, sleep, writeJSON } from './util.mjs';

const options = Object.fromEntries([
  'workspace', 'provider', 'review-provider', 'model', 'review-model', 'effort', 'review-effort',
  'workers', 'permissions', 'max-tasks', 'max-revisions', 'timeout', 'context-chars', 'curator-batch',
  'max-goal-rounds', 'max-no-progress', 'max-control-failures', 'max-attempts',
  'input-policy',
  'prompt', 'prompt-file', 'file', 'config', 'runs-root', 'codex-bin', 'claude-bin', 'target', 'query',
].map(name => [name, { type: 'string' }]));
for (const name of ['help', 'version', 'json', 'no-interactive', 'follow', 'models', 'yolo', 'global']) options[name] = { type: 'boolean' };
options.help.short = 'h';
const parsed = parseArgs({ options, allowPositionals: true });
const values = parsed.values;
const [command = 'start', ...positionals] = parsed.positionals;
const runsRoot = path.resolve(values['runs-root'] || defaultRunsRoot);
const runScope = { workspace: values.workspace || process.cwd(), global: Boolean(values.global) };

const help = `ID2A ${VERSION} — Codex / Claude 에이전트와 공유 사실 원장

  id2a                         현재 폴더에서 첫 프롬프트 입력
  id2a --prompt-file brief.txt  현재 폴더에서 파일로 첫 지시 입력
  id2a start --workspace C:\\project
  id2a start --workspace C:\\project --prompt "자료를 읽고 문서의 일관성을 확인해줘"
  id2a start --workspace C:\\project --prompt-file brief.txt --provider codex
  id2a start --workspace C:\\project --provider codex --review-provider claude --yolo
  id2a resume latest
  id2a status latest [--json]
  id2a logs latest --follow
  id2a send latest "추가 지시" [--target 1]
  id2a send latest --file instruction.txt
  id2a add latest "새로 확인할 작업"
  id2a retry latest --target 1
  id2a pause|continue|stop latest
  id2a facts latest [--query 검색어]
  id2a export latest
  id2a list
  id2a list --global
  id2a doctor [--provider codex|claude] [--models]
  id2a demo

start: 초기 프롬프트를 여러 줄로 붙여 넣고 마지막에 /end를 입력할 수 있습니다.
       파이프로 입력하면 UTF-8 표준입력 전체를 읽습니다.
       --provider codex|claude  --workers 2  --permissions yolo|workspace (기본 yolo)
       --input-policy continue|wait (기본 continue: 가역적 선택은 스스로 결정하고 계속)
       Codex 기본: --model gpt-5.6-sol --effort xhigh (Codex 검토 max)
       Claude 기본: CLI 모델 설정, effort auto
       --model MODEL  --review-model MODEL  --review-effort LEVEL
       --max-tasks 8  --max-revisions 2  --max-goal-rounds 12  --max-no-progress 3
       --max-control-failures 5  --max-attempts 100  --timeout 1200  --no-interactive  --json
       --max-tasks는 전체 종료 한도가 아니라 한 목표 사이클이 제안할 수 있는 작업 상한입니다.
       --config config.json으로 역할별 provider/model/effort도 지정할 수 있습니다.

latest와 list는 기본적으로 현재 폴더를 workspace로 사용하는 run만 찾습니다.
다른 폴더를 조회하려면 --workspace PATH, 모든 폴더를 조회하려면 --global을 사용하세요.
명시적인 run ID 또는 절대 경로는 workspace 필터와 관계없이 선택됩니다.

실행 중: /status /facts [검색어] /inspect T1 /note 지시 /send T1 지시 /file 경로
         /add 새 작업 /retry T1 /pause /resume /stop /effort [역할] LEVEL /workers N
         /input-policy continue|wait /help

개발 목표의 Worker는 원본 폴더를 직접 수정하고 검증합니다. 목표 판정 전에는 자동 종료하지 않습니다.
자동 실행하는 침입·악용·취약점 재현 프리셋은 포함하지 않습니다.
결과와 로그: ${runsRoot}
`;

function configPatch(base = {}) {
  const patch = { ...base, roleSettings: structuredClone(base.roleSettings || {}) };
  const map = { workspace: 'workspace', provider: 'provider', model: 'model', effort: 'effort', workers: 'workers',
    permissions: 'permissions', 'max-tasks': 'maxTasks', 'max-revisions': 'maxRevisions', timeout: 'timeout',
    'max-goal-rounds': 'maxGoalRounds', 'max-no-progress': 'maxNoProgress', 'max-control-failures': 'maxControlFailures',
    'max-attempts': 'maxAttempts',
    'input-policy': 'inputPolicy',
    'context-chars': 'contextCharacters', 'curator-batch': 'curatorBatch', 'codex-bin': 'codexBin', 'claude-bin': 'claudeBin' };
  for (const [option, key] of Object.entries(map)) if (values[option] !== undefined) patch[key] = values[option];
  if (values.yolo) patch.permissions = 'yolo';
  for (const key of ['provider', 'model', 'effort']) {
    if (values['review-' + key] !== undefined) {
      patch.roleSettings.supervisor ||= {};
      patch.roleSettings.supervisor[key] = values['review-' + key];
    }
  }
  return patch;
}
function summary(store) {
  const tasks = store.tasks();
  const counts = {};
  for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
  const completion = store.completionStatus();
  return { format_version: completion.format_version, goal_format_version: completion.goal_format_version,
    state: completion.execution_state, control: store.getMeta('control'),
    goal_outcome: completion.goal_outcome, termination: completion.termination, report: completion.report,
    contract: store.getMeta('goal:contract'), goal: store.getMeta('goal:assessment'), counts,
    facts: store.listFacts({ limit: 500 }).map(({ id, key, state }) => ({ id, key, state })),
    tasks: tasks.map(({ id, title, state, revisions, failures, feedback }) => ({ id, title, state, revisions, failures, feedback })) };
}
function showStatus(store) {
  const result = summary(store);
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`실행 ${result.state} / 목표 ${result.goal_outcome} / 보고서 ${result.report.state} / 제어 ${result.control}`);
    if (result.termination) console.log(`종료 이유 ${result.termination.reason}`);
    console.log(`작업 ${JSON.stringify(result.counts)} / 사실 ${result.facts.length}`);
    for (const task of result.tasks) console.log(`T${task.id} [${task.state}] ${task.title}${task.feedback ? ' · ' + task.feedback.slice(0, 140) : ''}`);
  }
}
function showFacts(store, query) {
  const facts = query ? store.search(query, { limit: 30 }) : store.listFacts({ limit: 30 });
  if (values.json) console.log(JSON.stringify(facts, null, 2));
  else for (const fact of facts) console.log(`F${fact.id} [${fact.state}/${fact.kind}] ${fact.key}: ${fact.claim}`);
  if (!facts.length && !values.json) console.log('저장된 사실 없음');
}
function renderEvent(event, rl) {
  if (event.type === 'run.finished') event = { ...event,
    goal_outcome: event.goal_outcome ?? 'legacy_unknown',
    termination_reason: event.termination_reason ?? 'legacy_unknown',
    report: event.report ?? 'legacy_unknown' };
  if (values.json) { console.log(JSON.stringify(event)); return; }
  if (['provider.message', 'provider.item', 'provider.stderr', 'provider.stdout'].includes(event.type)) {
    const text = event.text || JSON.stringify(event.item || {});
    console.log(`[${event.role || 'agent'}${event.task ? ':T' + event.task : ''}] ${text.slice(0, 700)}`);
  } else if (event.type === 'provider.usage') {
    console.log(`[usage ${event.role || ''}] ${JSON.stringify(event.usage || {}).slice(0, 180)}`);
  } else if (event.type === 'task.state') console.log(`[T${event.task}] ${event.state}${event.reason ? ': ' + event.reason.slice(0, 220) : ''}`);
  else if (event.type === 'agent.started') console.log(`[${event.role}${event.task ? ':T' + event.task : ''}] ${event.provider}, model=${event.model || 'CLI 기본'}, effort=${event.effort}`);
  else if (event.type === 'goal.waiting_input') console.log(`목표 진행에 외부 입력이 필요합니다: ${event.question}`);
  else if (event.type === 'goal.assessed') console.log(`[goal:${event.round}] ${event.decision}: ${event.reason.slice(0, 300)}`);
  else if (event.type === 'run.finished') console.log(`실행 종료: ${event.state} / 목표: ${event.goal_outcome} / 이유: ${event.termination_reason}\n보고서: ${event.report}`);
  else console.log(`[${event.type}] ${JSON.stringify(event).slice(0, 420)}`);
  if (rl) rl.prompt(true);
}
async function goalFromInput(rl) {
  if ((values.prompt !== undefined) + (values['prompt-file'] !== undefined || values.file !== undefined) > 1) throw new Error('--prompt와 --prompt-file을 함께 쓸 수 없습니다.');
  if (values.prompt !== undefined) return values.prompt;
  if (values['prompt-file'] || values.file) return readText(path.resolve(values['prompt-file'] || values.file));
  if (positionals.length) return positionals.join(' ');
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('표준입력 프롬프트 상한 2MB 초과');
    }
    return text.replace(/^\uFEFF/u, '');
  }
  console.log('첫 프롬프트를 입력하거나 여러 줄로 붙여 넣으세요. 마지막 줄에 /end를 입력하면 시작합니다.');
  return await new Promise((resolve, reject) => {
    const lines = [];
    const onLine = line => {
      if (line.trim() === '/end') { rl.off('line', onLine); rl.off('close', onClose); resolve(lines.join('\n')); }
      else lines.push(line);
    };
    const onClose = () => { rl.off('line', onLine); reject(new Error('프롬프트 입력 종료')); };
    rl.on('line', onLine); rl.once('close', onClose);
  });
}
function addTask(store, text) {
  return store.addTask({ title: text.slice(0, 100), brief: text, scope: 'user.extra' });
}
function retryTask(store, id) {
  const task = store.task(integer(id, 'target'));
  if (['running', 'queued', 'reviewing'].includes(task.state)) throw new Error('이미 실행 중이거나 대기 중인 작업입니다.');
  store.updateTask(task.id, { state: task.result ? 'reviewing' : 'queued', failures: 0, revisions: 0, feedback: task.feedback });
  return task.id;
}
async function interactiveCommand(engine, line) {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(line.trim());
  if (!match) { if (line.trim()) engine.store.message(line); return; }
  const [, cmd, argument = ''] = match;
  const store = engine.store;
  if (cmd === 'help') console.log(help);
  else if (cmd === 'status') showStatus(store);
  else if (cmd === 'facts') showFacts(store, argument);
  else if (cmd === 'inspect') console.log(JSON.stringify(store.task(integer(argument.replace(/^T/iu, ''), 'task')), null, 2));
  else if (cmd === 'note') store.message(argument);
  else if (cmd === 'file') store.message(readText(path.resolve(argument.replace(/^"|"$/gu, ''))));
  else if (cmd === 'send') {
    const targeted = /^(?:T)?(\d+)\s+([\s\S]+)$/iu.exec(argument);
    if (!targeted) throw new Error('/send T1 지시 형식으로 입력하세요.');
    store.message(targeted[2], targeted[1]);
  } else if (cmd === 'add') addTask(store, argument);
  else if (cmd === 'retry') retryTask(store, argument.replace(/^T/iu, ''));
  else if (cmd === 'pause' || cmd === 'resume') { store.setMeta('control', cmd === 'pause' ? 'paused' : 'running'); store.event('control.changed', { control: store.getMeta('control') }); }
  else if (cmd === 'stop') engine.stop();
  else if (cmd === 'workers' || cmd === 'effort' || cmd === 'input-policy') {
    const config = store.getMeta('config');
    if (cmd === 'workers') config.workers = integer(argument, 'workers', 1, 32);
    else if (cmd === 'effort') {
      const parts = argument.trim().split(/\s+/u);
      if (parts.length === 1) config.effort = parts[0];
      else if (parts.length === 2 && roles.includes(parts[0])) { config.roleSettings[parts[0]] ||= {}; config.roleSettings[parts[0]].effort = parts[1]; }
      else throw new Error('/effort [worker|supervisor|...] LEVEL 형식으로 입력하세요.');
    } else config.inputPolicy = argument.trim();
    store.setMeta('config', configuration(config));
    store.event('config.changed', { next_sessions: true, workers: config.workers, effort: config.effort, inputPolicy: config.inputPolicy, roleSettings: config.roleSettings });
  } else throw new Error(`알 수 없는 명령 /${cmd}; /help를 입력하세요.`);
}
async function runController(directory, rl, isResume = false) {
  let engine;
  const partial = new Map();
  const flush = () => {
    for (const [attempt, event] of partial) {
      if (!event.text) continue;
      if (values.json) console.log(JSON.stringify(event));
      else console.log(`[진행 ${event.role}${event.task ? ':T' + event.task : ''}] ${event.text.slice(0, 1200)}`);
      partial.delete(attempt);
    }
    if (rl) rl.prompt(true);
  };
  const deltaTimer = setInterval(flush, 500);
  const stop = () => engine?.stop();
  process.on('SIGINT', stop); process.on('SIGTERM', stop); rl?.on('SIGINT', stop);
  try {
    engine = new Engine(directory, { onEvent: event => renderEvent(event, rl), onDelta: event => {
      const previous = partial.get(event.attempt);
      partial.set(event.attempt, { ...event, text: (previous?.text || '') + event.text });
    } });
    if (isResume) {
      const extra = values.config ? readJSON(path.resolve(values.config)) : {};
      const merged = { ...engine.config, ...extra };
      const legacyPermissionUpgrade = Number(engine.manifest.version || 1) < 2 && merged.permissions === 'workspace'
        && values.permissions === undefined && !values.yolo && extra.permissions === undefined;
      if (legacyPermissionUpgrade) merged.permissions = 'yolo';
      engine.config = configuration(configPatch(merged));
      engine.store.setMeta('config', engine.config);
      if (legacyPermissionUpgrade) engine.store.event('config.migrated', { from_version: engine.manifest.version || 1, permissions: 'yolo' });
    }
    console.log(values.json ? JSON.stringify({ type: 'run.path', directory }) : `Run: ${directory}`);
    if (rl) {
      let chain = Promise.resolve();
      rl.on('line', line => {
        chain = chain.then(() => interactiveCommand(engine, line)).catch(error => console.log('입력 오류: ' + error.message));
        chain.then(() => rl.prompt(true));
      });
      rl.setPrompt('id2a> '); rl.prompt();
    }
    const state = await engine.run();
    const completion = engine.store.completionStatus();
    process.exitCode = state === 'stopped' ? 130
      : state === 'completed' && completion.goal_outcome === 'achieved' && completion.report.state === 'complete' ? 0 : 2;
  } finally {
    clearInterval(deltaTimer); flush();
    rl?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    engine?.close();
  }
}
async function doctor() {
  const report = { node: process.version, providers: [] };
  for (const name of values.provider ? [values.provider] : ['codex', 'claude']) {
    if (!['codex', 'claude'].includes(name)) throw new Error('provider는 codex 또는 claude');
    try {
      const executable = resolveCLI(name, values[name + '-bin']);
      const version = execFileSync(executable.command, [...executable.args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
      const entry = { name, installed: true, version };
      if (values.models && name === 'codex') entry.models = await new CodexSession({ cwd: process.cwd(), bin: values['codex-bin'] }).models();
      report.providers.push(entry);
    } catch (error) { report.providers.push({ name, installed: false, error: error.message }); process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
}
async function main() {
  if (values.version || command === 'version') { console.log(VERSION); return; }
  if (values.help || command === 'help') { console.log(help); return; }
  if (command === 'doctor') return doctor();
  if (command === 'list') {
    const runs = listRuns(runsRoot, runScope);
    for (const run of runs) {
      const store = new Store(run.directory, { readOnly: true });
      try {
        const completion = store.completionStatus();
        console.log(`${run.id} [${completion.execution_state}/${completion.goal_outcome}] ${run.workspace}`);
      }
      finally { store.close(); }
    }
    if (!runs.length) {
      if (values.global) console.log('저장된 run이 없습니다.');
      else console.log(`현재 workspace에 저장된 run이 없습니다: ${path.resolve(runScope.workspace)}\n전체 run: id2a list --global`);
    }
    return;
  }
  if (command === 'start') {
    const rl = process.stdin.isTTY && !values['no-interactive'] && !values.json ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    const inputRL = rl || (process.stdin.isTTY && !values.prompt && !values['prompt-file'] && !values.file && !positionals.length ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null);
    try {
      const goal = await goalFromInput(inputRL);
      if (inputRL && inputRL !== rl) inputRL.close();
      const base = values.config ? readJSON(path.resolve(values.config)) : {};
      const directory = createRun(configPatch(base), goal, runsRoot);
      await runController(directory, rl);
    } finally { inputRL?.close(); rl?.close(); }
    return;
  }
  if (command === 'demo') {
    const { demo } = await import('./demo.mjs');
    return demo(runsRoot, event => renderEvent(event));
  }
  if (command === 'resume') {
    const directory = resolveRun(positionals[0], runsRoot, runScope);
    const rl = process.stdin.isTTY && !values['no-interactive'] && !values.json ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    return runController(directory, rl, true);
  }
  const directory = resolveRun(positionals[0], runsRoot, runScope);
  if (!['status', 'facts', 'logs', 'send', 'add', 'retry', 'pause', 'continue', 'stop', 'export'].includes(command)) throw new Error(`알 수 없는 명령 ${command}; id2a help를 확인하세요.`);
  const mutation = ['send', 'add', 'retry', 'pause', 'continue', 'stop'].includes(command);
  const store = new Store(directory, { readOnly: !mutation });
  try {
    if (command === 'status') showStatus(store);
    else if (command === 'facts') showFacts(store, values.query);
    else if (command === 'send' || command === 'add') {
      const text = values.file ? readText(path.resolve(values.file)) : positionals.slice(1).join(' ');
      if (command === 'send') console.log(`추가 지시 #${store.message(text, values.target || 'all')} 저장됨. 실행 중이면 전달되고, 그 외에는 재개 시 반영됩니다.`);
      else console.log(`추가 작업 T${addTask(store, text)} 저장됨. 종료된 run은 resume으로 이어가세요.`);
    } else if (command === 'retry') console.log(`T${retryTask(store, values.target || positionals[1])} 재시도 대기. 종료된 run은 resume으로 이어가세요.`);
    else if (['pause', 'continue', 'stop'].includes(command)) {
      const control = { pause: 'paused', continue: 'running', stop: 'stopped' }[command];
      store.setMeta('control', control); store.event('control.changed', { control });
      console.log(`제어 요청: ${control}`);
    } else if (command === 'export') {
      const file = path.join(directory, 'snapshot.json');
      writeJSON(file, { ...summary(store), source: readJSON(path.join(directory, 'run.json')).source, facts: store.allFacts(), digests: store.db.prepare('SELECT * FROM digests').all() });
      console.log(file);
    } else if (command === 'logs') {
      let after = 0, stopped = false;
      const stop = () => { stopped = true; };
      process.on('SIGINT', stop);
      try {
        do {
          const events = store.events(after, 100);
          for (const event of events) { renderEvent(event); after = event.id; }
          if (!values.follow) { if (events.length === 100) continue; break; }
          if (events.length < 100) await sleep(300);
        } while (!stopped);
      } finally { process.off('SIGINT', stop); }
    }
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`ID2A: ${error.message}`); process.exitCode = 1; });
}
