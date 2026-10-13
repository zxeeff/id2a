import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { schemas, validate } from './schemas.mjs';
import { makePrompt } from './prompts.mjs';
import { providerFor } from './providers.mjs';
import { acquireLock, boundedJSON, hash, integer, now, readJSON, readText, sleep, sourceIdentity, writeJSON } from './util.mjs';

export const defaultRunsRoot = fileURLToPath(new URL('../runs/', import.meta.url));
export const roles = ['planner', 'worker', 'supervisor', 'triage', 'goal', 'curator', 'editor'];

function workspaceKey(workspace) {
  let resolved = path.resolve(workspace);
  try { resolved = fs.realpathSync(resolved); }
  catch { /* A saved workspace may have been moved or removed. */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function listRuns(root = defaultRunsRoot, { workspace = process.cwd(), global = false } = {}) {
  const runsRoot = path.resolve(root);
  if (!fs.existsSync(runsRoot)) return [];
  const expectedWorkspace = global ? null : workspaceKey(workspace);
  return fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const directory = path.join(runsRoot, entry.name);
      const manifestPath = path.join(directory, 'run.json');
      const ledgerPath = path.join(directory, 'ledger.sqlite');
      if (!fs.existsSync(manifestPath) || !fs.existsSync(ledgerPath)) return null;
      const manifest = readJSON(manifestPath);
      const runWorkspace = manifest.config?.workspace || manifest.source?.path;
      if (!global && (!runWorkspace || workspaceKey(runWorkspace) !== expectedWorkspace)) return null;
      return { id: entry.name, directory, workspace: runWorkspace || null, manifest };
    })
    .filter(Boolean)
    .sort((left, right) => right.id.localeCompare(left.id));
}

export function configuration(input = {}) {
  const provider = input.provider || 'codex';
  const config = {
    workspace: path.resolve(input.workspace || process.cwd()), provider, workers: 2,
    permissions: 'yolo', inputPolicy: 'continue', effort: provider === 'codex' ? 'xhigh' : 'auto',
    model: provider === 'codex' ? 'gpt-5.6-sol' : null, maxTasks: 8, maxRevisions: 2,
    maxFailures: 2, contextCharacters: 12000, curatorBatch: 4, timeout: 1200,
    roleSettings: {}, ...input,
  };
  config.workspace = fs.realpathSync(config.workspace);
  if (!fs.statSync(config.workspace).isDirectory()) throw new Error('workspace는 폴더여야 합니다.');
  if (!['codex', 'claude'].includes(config.provider)) throw new Error('provider는 codex 또는 claude입니다.');
  if (!['workspace', 'yolo'].includes(config.permissions)) throw new Error('permissions는 workspace 또는 yolo입니다.');
  if (!['continue', 'wait'].includes(config.inputPolicy)) throw new Error('inputPolicy는 continue 또는 wait입니다.');
  const levels = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (!levels.includes(config.effort)) throw new Error('잘못된 effort');
  for (const [label, min, max] of [['workers', 1, 32], ['maxTasks', 1, 32], ['maxRevisions', 0, 20], ['maxFailures', 1, 10], ['contextCharacters', 2000, 100000], ['curatorBatch', 1, 100], ['timeout', 5, 86400]]) {
    config[label] = integer(config[label], label, min, max);
  }
  for (const [role, settings] of Object.entries(config.roleSettings)) {
    if (!roles.includes(role)) throw new Error(`알 수 없는 역할: ${role}`);
    if (settings.provider && !['codex', 'claude'].includes(settings.provider)) throw new Error(`${role}: provider 오류`);
    if (settings.effort && !levels.includes(settings.effort)) throw new Error(`${role}: effort 오류`);
  }
  for (const role of roles) {
    const setting = config.roleSettings[role] || {};
    const provider = setting.provider || config.provider;
    const effort = setting.effort || (provider === config.provider ? config.effort : 'auto');
    if (provider === 'claude' && !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`${role}: Claude CLI는 effort ${effort}를 지원하지 않습니다.`);
  }
  return config;
}
export function createRun(input, goal, root = defaultRunsRoot) {
  if (!goal.trim()) throw new Error('첫 프롬프트가 비어 있습니다.');
  if (Buffer.byteLength(goal, 'utf8') > 2 * 1024 * 1024) throw new Error('초기 프롬프트는 UTF-8 2MB 이하로 입력하세요.');
  const config = configuration(input);
  // Apply the review preset only to new runs; saved runs keep their settings.
  const reviewer = config.roleSettings.supervisor || {};
  if (config.provider === 'codex' && (reviewer.provider || config.provider) === 'codex' && reviewer.effort === undefined) {
    config.roleSettings = structuredClone(config.roleSettings);
    config.roleSettings.supervisor = { ...reviewer, effort: 'max' };
  }
  const id = now().replace(/[:.]/gu, '-').replace('Z', '') + '-' + crypto.randomUUID().slice(0, 8);
  const directory = path.resolve(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'prompt.txt'), goal, 'utf8');
  writeJSON(path.join(directory, 'run.json'), { id, version: 2, created: now(), source: sourceIdentity(config.workspace), config });
  const store = new Store(directory);
  try {
    store.setMeta('state', 'created');
    store.setMeta('control', 'running');
    store.setMeta('config', config);
    store.event('run.created', { run: id, workspace: config.workspace });
  } finally { store.close(); }
  return directory;
}
export function resolveRun(value = 'latest', root = defaultRunsRoot, options = {}) {
  let directory;
  if (value === 'latest') {
    const runs = listRuns(root, options);
    if (!runs.length) {
      if (options.global) throw new Error('저장된 run이 없습니다.');
      const workspace = path.resolve(options.workspace || process.cwd());
      throw new Error(`현재 workspace에 저장된 run이 없습니다: ${workspace}. 전체 run은 --global로 조회하세요.`);
    }
    directory = runs[0].directory;
  } else directory = path.isAbsolute(value) ? value : path.join(root, value);
  if (!fs.existsSync(path.join(directory, 'run.json')) || !fs.existsSync(path.join(directory, 'ledger.sqlite'))) throw new Error(`ID2A run이 아닙니다: ${directory}`);
  return path.resolve(directory);
}

export class Engine {
  constructor(directory, { onEvent, onDelta, providerFactory = providerFor } = {}) {
    this.directory = path.resolve(directory);
    this.manifest = readJSON(path.join(this.directory, 'run.json'));
    this.goal = readText(path.join(this.directory, 'prompt.txt'));
    this.releaseLock = acquireLock(this.directory);
    try { this.store = new Store(this.directory, { onEvent }); }
    catch (error) { this.releaseLock(); throw error; }
    try { this.config = configuration(this.store.getMeta('config', this.manifest.config)); }
    catch (error) { this.store.close(); this.releaseLock(); throw error; }
    this.providerFactory = providerFactory;
    this.onDelta = onDelta;
    this.sessions = new Map();
    this.activeTasks = new Map();
    this.abortController = new AbortController();
    this.polling = false;
  }
  settings(role) {
    const overrides = this.config.roleSettings[role] || {};
    const provider = overrides.provider || this.config.provider;
    return { provider,
      model: provider === this.config.provider ? this.config.model : null,
      effort: provider === this.config.provider ? this.config.effort : 'auto',
      ...overrides };
  }
  stop() {
    this.store.setMeta('control', 'stopped');
    this.abortController.abort();
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      this.config = configuration(this.store.getMeta('config', this.config));
      if (this.store.getMeta('control') === 'stopped') this.abortController.abort();
      for (const [attempt, active] of this.sessions) {
        for (const message of this.store.pendingMessages(attempt, active.taskID)) {
          try {
            const state = await active.session.steer(`Additional user instruction (#${message.id}):\n${message.text}`);
            if (state !== 'pending') {
              this.store.delivered(message.id, attempt, state);
              this.store.event('instruction.delivered', { message: message.id, attempt, task: active.taskID, state });
            }
          } catch (error) {
            // The instruction stays pending when a turn has just ended or has not started.
            if (!active.session.done) this.store.event('instruction.pending', { message: message.id, attempt, reason: error.message });
          }
        }
      }
    } finally { this.polling = false; }
  }
  async runAgent(role, task, data = {}) {
    const settings = this.settings(role);
    const taskID = task?.id || null;
    const attempt = this.store.beginAttempt(taskID, role, settings.provider);
    const taskDirectory = path.join(this.directory, 'tasks', taskID ? 'T' + taskID : role);
    const attemptDirectory = path.join(this.directory, 'attempts', String(attempt));
    fs.mkdirSync(taskDirectory, { recursive: true });
    fs.mkdirSync(attemptDirectory, { recursive: true });
    const instructions = this.store.messages(taskID);
    const promptTask = task?.result ? { ...task, result: {
      summary: task.result.summary, fact_ids: task.result.fact_ids,
      artifacts: (task.result.artifacts || []).map(artifact => ({ path: path.join(taskDirectory, 'outputs', artifact.path), bytes: Buffer.byteLength(artifact.content), sha256: hash(artifact.content) })),
    } } : task;
    const prompt = makePrompt(role, {
      goal: this.goal, task: promptTask, workspace: this.config.workspace, directory: taskDirectory,
      instructions, maxTasks: this.config.maxTasks, inputPolicy: this.config.inputPolicy, ...data,
    });
    fs.writeFileSync(path.join(attemptDirectory, 'prompt.txt'), prompt, 'utf8');
    writeJSON(path.join(attemptDirectory, 'schema.json'), schemas[role]);
    const onEvent = event => {
      fs.appendFileSync(path.join(attemptDirectory, 'stream.jsonl'), JSON.stringify(event) + '\n');
      if (event.type === 'provider.delta') { this.onDelta?.({ type: 'agent.delta', task: taskID, role, attempt, text: event.text }); return; }
      const { type, ...detail } = event;
      this.store.event(type, { attempt, task: taskID, role, ...detail });
    };
    const workingDirectory = role === 'worker' ? this.config.workspace : taskDirectory;
    const session = this.providerFactory(settings.provider, {
      cwd: workingDirectory, taskDirectory, workspace: this.config.workspace, runDirectory: this.directory,
      timeout: this.config.timeout, bin: this.config[settings.provider + 'Bin'],
      onEvent, onRaw: event => fs.appendFileSync(path.join(attemptDirectory, 'raw.jsonl'), JSON.stringify(event) + '\n'),
      onSession: (sessionID, turnID) => this.store.session(attempt, sessionID, turnID),
    });
    for (const instruction of instructions) this.store.delivered(instruction.id, attempt, 'included');
    this.sessions.set(attempt, { session, taskID });
    this.store.event('agent.started', { attempt, task: taskID, role, provider: settings.provider, model: settings.model, effort: settings.effort, directory: workingDirectory });
    try {
      const result = validate(await session.run({
        prompt, schema: schemas[role], signal: this.abortController.signal,
        sessionID: role === 'worker' ? this.store.interruptedSession(taskID, settings.provider) : undefined,
        readOnly: role !== 'worker', model: settings.model, effort: settings.effort, permissions: this.config.permissions,
      }), schemas[role]);
      writeJSON(path.join(attemptDirectory, 'result.json'), result);
      this.store.endAttempt(attempt, 'completed');
      this.store.event('agent.completed', { attempt, task: taskID, role });
      return { result, directory: taskDirectory };
    } catch (error) {
      this.store.endAttempt(attempt, this.abortController.signal.aborted ? 'interrupted' : 'failed');
      this.store.event('agent.failed', { attempt, task: taskID, role, reason: error.message });
      throw error;
    } finally {
      this.sessions.delete(attempt);
      if (role === 'worker') {
        const previous = this.store.getMeta('source:current', this.manifest.source);
        const current = sourceIdentity(this.config.workspace);
        this.store.setMeta('source:current', current);
        if (JSON.stringify(previous) !== JSON.stringify(current)) this.store.event('workspace.changed', { task: taskID, previous, current });
      }
    }
  }
  async plan() {
    if (this.store.getMeta('planned')) return;
    const existing = path.join(this.directory, 'plan.json');
    const plan = fs.existsSync(existing) ? validate(readJSON(existing), schemas.planner) : (await this.runAgent('planner')).result;
    if (plan.tasks.length > this.config.maxTasks) throw new Error('계획의 초기 작업 상한 초과');
    const seen = new Set();
    for (const [index, task] of plan.tasks.entries()) {
      if (task.depends_on.some(dependency => dependency < 0 || dependency >= index)) throw new Error('계획은 앞선 작업만 선행 작업으로 참조할 수 있습니다.');
      const identity = hash(`${task.title}\n${task.brief}\n${task.scope}`.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase());
      if (seen.has(identity)) throw new Error('계획에 중복 작업이 있습니다.');
      seen.add(identity);
    }
    writeJSON(existing, plan);
    const ids = [];
    for (const [index, task] of plan.tasks.entries()) {
      const brief = { title: task.title, brief: task.brief, scope: task.scope };
      ids.push(this.store.existingTask(brief) || this.store.addTask(brief, { dependencies: task.depends_on.map(dependency => ids[dependency]) }));
    }
    this.store.setMeta('planned', true);
    this.store.event('plan.created', { summary: plan.summary, tasks: ids });
  }
  async runTask(initialTask) {
    const id = initialTask.id;
    try {
      let task = this.store.task(id);
      if (task.kind === 'conflict') {
        this.store.updateTask(id, { state: 'running' });
        const facts = this.store.listFacts({ state: 'conflicted', limit: 500 }).filter(fact => fact.key === task.brief);
        if (facts.length < 2) { this.store.updateTask(id, { state: 'accepted', feedback: '충돌이 이미 해소됐습니다.' }); return; }
        const { result } = await this.runAgent('supervisor', task, { facts });
        this.store.applyVerdict(id, result, facts.map(fact => fact.id));
        this.store.updateTask(id, { state: result.decision === 'reject' ? 'rejected' : result.decision === 'revise' ? 'stalled' : 'accepted', feedback: result.reason });
        return;
      }
      if (!task.result) {
        this.store.updateTask(id, { state: 'running' });
        const { result, directory } = await this.runAgent('worker', task, { context: this.store.context(task, this.config.contextCharacters), feedback: task.feedback });
        this.store.submitWorker(id, result, directory, this.config.workspace);
        task = this.store.task(id);
      }
      const facts = this.store.factsForTask(id).filter(fact => task.result.fact_ids.includes(fact.id));
      this.store.checkEvidence(facts);
      const { result: verdict } = await this.runAgent('supervisor', task, { facts });
      this.store.applyVerdict(id, verdict, task.result.fact_ids);
      if (verdict.decision === 'accept') {
        this.store.updateTask(id, { state: 'accepted', feedback: verdict.reason });
        try { await this.followups(this.store.task(id)); }
        catch (error) {
          if (this.abortController.signal.aborted) throw error;
          this.store.event('followup.failed', { task: id, reason: error.message });
        }
        this.queueConflicts();
      } else if (verdict.decision === 'reject') this.store.updateTask(id, { state: 'rejected', feedback: verdict.reason });
      else if (task.revisions >= this.config.maxRevisions) this.store.updateTask(id, { state: 'stalled', feedback: verdict.reason });
      else this.store.updateTask(id, { state: 'queued', result: null, revisions: task.revisions + 1, feedback: verdict.reason });
    } catch (error) {
      const task = this.store.task(id);
      if (this.abortController.signal.aborted) {
        this.store.updateTask(id, { state: task.result ? 'reviewing' : 'queued', feedback: task.feedback });
      } else {
        const failures = task.failures + 1;
        this.store.updateTask(id, { state: failures >= this.config.maxFailures ? 'stalled' : task.result ? 'reviewing' : 'queued', failures, feedback: error.message });
      }
    }
  }
  async followups(task) {
    if (this.store.getMeta('followups:' + task.id)) return;
    for (const candidate of task.result.followups) {
      const signature = hash(`${task.id}\n${candidate.title}\n${candidate.brief}\n${candidate.scope}`);
      if (this.store.getMeta('triage:' + signature)) continue;
      const { result } = await this.runAgent('triage', task, { candidate, context: this.store.context(task, this.config.contextCharacters) });
      this.store.setMeta('triage:' + signature, result);
      if (result.decision === 'approve') {
        const id = this.store.addTask(candidate, { dependencies: [task.id] });
        this.store.event(id ? 'followup.approved' : 'followup.rejected', { task: task.id, followup: id, title: candidate.title, reason: id ? result.reason : '중복 작업' });
      } else this.store.event('followup.rejected', { task: task.id, title: candidate.title, reason: result.reason });
    }
    this.store.setMeta('followups:' + task.id, true);
  }
  queueConflicts() {
    const facts = this.store.listFacts({ state: 'conflicted', limit: 500 });
    const groups = Map.groupBy(facts, fact => fact.key);
    for (const [key, group] of groups) {
      this.store.addTask({ title: 'Resolve fact conflict: ' + key, brief: key, scope: group[0].scope }, {
        kind: 'conflict', signature: 'conflict:' + key + ':' + group.map(fact => fact.id).sort((a, b) => a - b).join(','),
      });
    }
  }
  async curate(force = false) {
    const groups = Map.groupBy(this.store.allFacts('verified'), fact => fact.scope);
    for (const [scope, facts] of groups) {
      const progress = this.store.curationProgress(scope);
      this.store.setMeta('curated_ids:' + scope, progress.indexed_ids);
      let pending = facts.filter(fact => !progress.processed_ids.includes(fact.id));
      if (!pending.length || (!force && pending.length < this.config.curatorBatch)) continue;
      while (pending.length) {
        const candidates = pending.map(({ id, key, claim, kind, scope }) => ({ id, key, claim, kind, scope }));
        const pack = boundedJSON(candidates, Math.max(this.config.contextCharacters, JSON.stringify(candidates[0]).length + 2));
        const { items: compact, ...coverage } = pack;
        const inputIDs = compact.map(fact => fact.id);
        const delivered = this.store.getMeta('curation_delivered:' + scope, []);
        this.store.setMeta('curation_delivered:' + scope, [...new Set([...delivered, ...inputIDs])]);
        this.store.event('digest.input', { scope, input_ids: inputIDs, ...coverage });
        try {
          const { result } = await this.runAgent('curator', null, { facts: compact, context: { scope, coverage: { facts: coverage } } });
          if (result.scope !== scope || result.fact_ids.some(id => !inputIDs.includes(id))) throw new Error('요약의 범위 또는 인용 ID 오류');
          if (inputIDs.some(id => this.store.fact(id).state !== 'verified')) throw new Error('요약 중 입력 사실의 검증 상태가 변경됐습니다.');
          this.store.transaction(() => {
            const digestID = this.store.addDigest(result, { emitEvent: false });
            const batches = this.store.getMeta('curation_batches:' + scope, []);
            batches.push({ digest_id: digestID, input_ids: inputIDs, indexed_ids: result.fact_ids,
              unindexed_ids: inputIDs.filter(id => !result.fact_ids.includes(id)) });
            this.store.setMeta('curation_batches:' + scope, batches);
          });
          // Compatibility marker now means actually linked, never merely seen.
          this.store.setMeta('curated_ids:' + scope, this.store.curationProgress(scope).indexed_ids);
          this.store.event('digest.updated', { scope, input_ids: inputIDs, facts: result.fact_ids });
          pending = pending.filter(fact => !inputIDs.includes(fact.id));
        } catch (error) {
          if (this.abortController.signal.aborted) throw error;
          this.store.event('digest.failed', { scope, input_ids: inputIDs, reason: error.message });
          break; // Retry this batch on the next curation pass; do not mark it done.
        }
        if (!force) break;
      }
    }
  }
  goalContext() {
    const view = this.store.ledgerView();
    const { tasks, snapshot } = view;
    const verified = view.facts.filter(fact => fact.state === 'verified');
    const conflicted = view.facts.filter(fact => fact.state === 'conflicted');
    const budget = Math.floor(this.config.contextCharacters * 0.4);
    const ordered = tasks.toReversed().sort((a, b) => Number(a.state === 'accepted') - Number(b.state === 'accepted'));
    const { items: compactTasks, ...taskCoverage } = boundedJSON(ordered.map(task => this.store.taskRecord(task)), budget);
    compactTasks.sort((a, b) => a.id - b.id);
    const { items: compactFacts, ...factCoverage } = boundedJSON(verified.toReversed().map(({ id, key, scope, kind, claim }) => ({ id, key, scope, kind, claim })), budget);
    compactFacts.reverse();
    const knowledge = this.store.knowledgeContext(view, this.config.contextCharacters - budget * 2);
    const coverage = { ...knowledge.coverage, tasks: taskCoverage, facts: { ...factCoverage, state: 'verified' } };
    const counts = {};
    for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
    return { tasks, verified, conflicted, compactTasks, compactFacts, counts, knowledge, coverage, snapshot };
  }
  queueGoalTasks(candidates, round, reason) {
    const scheduled = [];
    const ids = [];
    const seen = new Set();
    const terminal = new Set(['stalled', 'rejected', 'blocked', 'cancelled']);
    for (const [index, candidate] of candidates.slice(0, this.config.maxTasks).entries()) {
      if (!candidate.title.trim() || !candidate.brief.trim() || !candidate.scope.trim()) throw new Error('목표 후속 작업의 제목/지시/범위가 비어 있습니다.');
      if (candidate.depends_on.some(dependency => dependency < 0 || dependency >= index)) throw new Error('목표 후속 작업은 앞선 작업만 선행 작업으로 참조할 수 있습니다.');
      const identity = hash(`${candidate.title}\n${candidate.brief}\n${candidate.scope}`.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase());
      if (seen.has(identity)) throw new Error('목표 후속 작업에 중복이 있습니다.');
      seen.add(identity);
      const dependencies = candidate.depends_on.map(dependency => ids[dependency]);
      const brief = { title: candidate.title, brief: candidate.brief, scope: candidate.scope };
      const same = this.store.tasks().filter(task => task.title === candidate.title && task.brief === candidate.brief && task.scope === candidate.scope).at(-1);
      if (same?.state === 'accepted') { ids.push(same.id); continue; }
      if (same && terminal.has(same.state) && JSON.stringify(same.dependencies) === JSON.stringify(dependencies)) {
        this.store.updateTask(same.id, { state: 'queued', result: null, revisions: 0, failures: 0, feedback: `목표 사이클 ${round} 재시도: ${reason}` });
        scheduled.push(same.id);
        ids.push(same.id);
        continue;
      }
      if (same && ['queued', 'reviewing', 'running'].includes(same.state)) { scheduled.push(same.id); ids.push(same.id); continue; }
      const id = this.store.addTask(brief, {
        dependencies,
        signature: hash(`goal:${round}\n${candidate.title}\n${candidate.brief}\n${candidate.scope}`),
      });
      if (!id) throw new Error('목표 후속 작업을 대기열에 넣지 못했습니다.');
      scheduled.push(id);
      ids.push(id);
    }
    return scheduled;
  }
  async assessGoal() {
    const beforeTasks = JSON.stringify(this.store.tasks().map(task => [task.id, task.state, task.revisions, task.failures]));
    const beforeMessage = this.store.messages(null).at(-1)?.id || 0;
    const round = this.store.getMeta('goal:round', 0) + 1;
    const view = this.goalContext();
    const { result } = await this.runAgent('goal', null, {
      facts: view.compactFacts,
      context: {
        ...view.knowledge,
        coverage: view.coverage,
        round,
        task_counts: view.counts,
        tasks: view.compactTasks,
        conflicts: view.conflicted.map(({ id, key, claim }) => ({ id, key, claim })),
        previous_assessment: this.store.getMeta('goal:assessment'),
        controller_feedback: this.store.getMeta('goal:feedback', ''),
        current_source: sourceIdentity(this.config.workspace),
      },
    });
    if (view.snapshot !== this.store.ledgerView().snapshot || beforeTasks !== JSON.stringify(this.store.tasks().map(task => [task.id, task.state, task.revisions, task.failures])) || beforeMessage !== (this.store.messages(null).at(-1)?.id || 0)) {
      this.store.event('goal.changed_during_review', { round });
      return { kind: 'changed' };
    }
    const verifiedIDs = new Set(view.verified.map(fact => fact.id));
    if (new Set(result.fact_ids).size !== result.fact_ids.length || result.fact_ids.some(id => !verifiedIDs.has(id))) throw new Error('목표 판정이 현재 검증되지 않은 사실을 인용했습니다.');
    if (result.next_tasks.length > this.config.maxTasks) throw new Error('목표 판정의 다음 작업 수가 사이클 상한을 초과했습니다.');
    if (result.decision === 'complete' && (result.next_tasks.length || result.question.trim())) throw new Error('완료 판정에는 다음 작업이나 질문을 포함할 수 없습니다.');
    if (result.decision === 'continue' && (!result.next_tasks.length || result.question.trim())) throw new Error('계속 판정에는 하나 이상의 다음 작업과 빈 질문이 필요합니다.');
    if (result.decision === 'needs_input' && (result.next_tasks.length || !result.question.trim())) throw new Error('입력 대기 판정에는 다음 작업 없이 정확한 질문이 필요합니다.');
    if (result.decision === 'complete' && (!view.tasks.some(task => task.state === 'accepted') || view.conflicted.length)) throw new Error('승인된 작업과 충돌 없는 근거 없이 목표를 완료할 수 없습니다.');
    if (result.decision === 'needs_input' && this.config.inputPolicy === 'continue') {
      const feedback = `무인 연속 실행 정책에서는 사용자 입력을 기다릴 수 없습니다. 질문(${result.question})은 차단 사유가 아닙니다. 범위·기준선·우선순위·검증 방법처럼 되돌릴 수 있는 선택은 가장 안전하고 제한적인 합리적 기본값을 채택해 가정으로 기록하고, 실제 작업을 수행할 다음 작업을 제안하세요. 외부 자원이 없으면 가능한 우회·대체 검증·부분 구현을 시도하세요.`;
      this.store.setMeta('goal:round', round);
      this.store.setMeta('goal:feedback', feedback);
      this.store.setMeta('state', 'running');
      this.store.event('goal.input_bypassed', { round, question: result.question, reason: result.reason });
      return { kind: 'retry' };
    }
    const assessment = { ...result, round, at: now() };
    this.store.setMeta('goal:round', round);
    this.store.setMeta('goal:assessment', assessment);
    this.store.setMeta('goal:feedback', '');
    this.store.event('goal.assessed', { round, decision: result.decision, reason: result.reason, progress: result.progress });
    if (result.decision === 'complete') return { kind: 'complete', assessment };
    if (result.decision === 'needs_input') {
      this.store.setMeta('state', 'waiting_input');
      this.store.event('goal.waiting_input', { round, question: result.question });
      return { kind: 'waiting', marker: beforeMessage };
    }
    const scheduled = this.queueGoalTasks(result.next_tasks, round, result.reason);
    if (!scheduled.length) {
      const feedback = '계속 판정이 실행 가능한 새 작업을 만들지 못했습니다. 완료된 작업을 반복하지 말고 다른 구체적 접근을 제안하세요.';
      this.store.setMeta('goal:feedback', feedback);
      this.store.event('goal.replan_required', { round, reason: feedback });
      return { kind: 'retry' };
    }
    this.store.setMeta('state', 'running');
    this.store.event('goal.continued', { round, tasks: scheduled });
    return { kind: 'continue', tasks: scheduled };
  }
  async waitForInstruction(marker) {
    while (!this.abortController.signal.aborted) {
      await this.poll();
      if (this.store.getMeta('control') === 'paused') { await sleep(300); continue; }
      if (this.store.readyTasks().length || (this.store.messages(null).at(-1)?.id || 0) > marker) {
        this.store.setMeta('state', 'running');
        this.store.event('goal.resumed', { after_message: marker });
        return;
      }
      await sleep(300);
    }
  }
  async report(assessment) {
    const view = this.goalContext();
    const { tasks, verified: facts, conflicted } = view;
    const messageCutoff = this.store.messages(null).at(-1)?.id || 0;
    const taskSnapshot = JSON.stringify(tasks.map(task => [task.id, task.state]));
    let editor;
    try {
      const { result } = await this.runAgent('editor', null, {
        facts: view.compactFacts,
        context: { ...view.knowledge, coverage: view.coverage, task_counts: view.counts, goal_assessment: assessment,
          tasks: view.compactTasks, conflicts: conflicted.map(({ id, key, claim }) => ({ id, key, claim })) },
      });
      if (new Set(result.fact_ids).size !== result.fact_ids.length || result.fact_ids.some(id => !facts.some(fact => fact.id === id))) throw new Error('최종 보고서에 중복 또는 검증되지 않은 사실 인용');
      editor = result;
    } catch (error) {
      if (this.abortController.signal.aborted) throw error;
      this.store.event('report.editor_failed', { reason: error.message });
      editor = { title: 'ID2A 결과', body: '최종 편집 세션이 실패했습니다. 아래 원장과 작업 상태를 확인하세요.', fact_ids: [] };
    }
    if (view.snapshot !== this.store.ledgerView().snapshot || this.store.getMeta('control') !== 'running' || taskSnapshot !== JSON.stringify(this.store.tasks().map(task => [task.id, task.state])) || messageCutoff !== (this.store.messages(null).at(-1)?.id || 0)) return 'changed';
    const state = 'completed';
    const manifest = { run: this.manifest.id, state, source: this.manifest.source, current_source: sourceIdentity(this.config.workspace), goal: assessment, tasks, facts, conflicts: conflicted, editor, ended: now() };
    writeJSON(path.join(this.directory, 'result.json'), manifest);
    const lines = [`# ${editor.title}`, '', `Run: ${this.manifest.id}`, `상태: ${state}`, `자료 폴더: ${this.config.workspace}`, '', `목표 판정: ${assessment.reason}`, `진행 요약: ${assessment.progress}`, '', editor.body, '', '## 작업', '',
      ...tasks.map(task => `- T${task.id} [${task.state}] ${task.title}${task.feedback ? ' — ' + task.feedback : ''}`), '', '## 검증된 사실과 증거', ''];
    for (const fact of facts) {
      lines.push(`- F${fact.id} [${fact.kind}] ${fact.key}: ${fact.claim}`);
      for (const evidence of fact.evidence) lines.push(`  - SHA-256 ${evidence.sha256}; 원본 ${evidence.source}; 보관 ${evidence.artifact}`);
    }
    if (conflicted.length) lines.push('', '## 해결되지 않은 충돌', '', ...conflicted.map(fact => `- F${fact.id} ${fact.key}: ${fact.claim}`));
    fs.writeFileSync(path.join(this.directory, 'report.md'), lines.join('\n') + '\n', 'utf8');
    this.store.setMeta('state', state);
    this.store.event('run.finished', { state, tasks: tasks.length, verified: facts.length, report: path.join(this.directory, 'report.md') });
    return state;
  }
  async run() {
    const source = sourceIdentity(this.config.workspace);
    const expected = this.store.getMeta('source:current', this.manifest.source);
    if (source.path !== expected.path) throw new Error('자료 폴더 경로가 바뀌었습니다. 올바른 workspace로 다시 실행하세요.');
    if (JSON.stringify(source) !== JSON.stringify(expected)) this.store.event('workspace.external_change', { expected, current: source });
    this.store.setMeta('source:current', source);
    this.store.recover();
    this.store.setMeta('control', 'running');
    this.store.setMeta('state', 'running');
    this.store.event('run.started', { run: this.manifest.id });
    const ticker = setInterval(() => this.poll().catch(error => this.store.event('controller.warning', { reason: error.message })), 300);
    try {
      let planFailures = 0;
      while (!this.store.getMeta('planned') && !this.abortController.signal.aborted) {
        try { await this.plan(); planFailures = 0; }
        catch (error) {
          planFailures++;
          this.store.setMeta('state', 'retrying');
          this.store.event('plan.retry', { failures: planFailures, reason: error.message });
          await sleep(Math.min(30000, 1000 * (2 ** Math.min(planFailures - 1, 5))));
        }
      }
      // Followups interrupted after a task was accepted must not be lost on resume.
      for (const task of this.store.tasks().filter(task => task.state === 'accepted' && task.kind === 'work')) {
        try { await this.followups(task); }
        catch (error) { this.store.event('followup.failed', { task: task.id, reason: error.message }); }
      }
      this.queueConflicts();
      let goalFailures = 0;
      while (!this.abortController.signal.aborted) {
        await this.poll();
        if (this.store.getMeta('control') === 'paused') { await sleep(200); continue; }
        if (!this.activeTasks.size && this.store.tasks().some(task => task.state === 'accepted')) await this.curate(false);
        const ready = this.store.readyTasks().filter(task => !this.activeTasks.has(task.id));
        for (const task of ready) {
          if (this.activeTasks.size >= this.config.workers) break;
          const running = this.runTask(task).finally(() => this.activeTasks.delete(task.id));
          this.activeTasks.set(task.id, running);
        }
        if (!this.activeTasks.size) {
          const waiting = this.store.tasks().filter(task => ['queued', 'reviewing', 'running'].includes(task.state));
          if (waiting.length) {
            for (const task of waiting) this.store.updateTask(task.id, { state: 'blocked', feedback: '선행 작업을 충족하는 실행 경로 없음' });
          }
          await this.curate(true);
          if (this.store.readyTasks().length || this.store.getMeta('control') !== 'running') continue;
          let outcome;
          try {
            outcome = await this.assessGoal();
            goalFailures = 0;
          } catch (error) {
            goalFailures++;
            this.store.setMeta('state', 'retrying');
            this.store.setMeta('goal:feedback', error.message);
            this.store.event('goal.retry', { failures: goalFailures, reason: error.message });
            await sleep(Math.min(30000, 1000 * (2 ** Math.min(goalFailures - 1, 5))));
            continue;
          }
          if (outcome.kind === 'changed' || outcome.kind === 'continue') continue;
          if (outcome.kind === 'retry') { await sleep(1000); continue; }
          if (outcome.kind === 'waiting') { await this.waitForInstruction(outcome.marker); continue; }
          const reported = await this.report(outcome.assessment);
          if (reported === 'changed') continue;
          return reported;
        }
        await sleep(100);
      }
      await Promise.allSettled(this.activeTasks.values());
      this.store.setMeta('state', 'stopped');
      this.store.event('run.stopped', { resume: this.directory });
      return 'stopped';
    } catch (error) {
      if (this.abortController.signal.aborted) {
        await Promise.allSettled(this.activeTasks.values());
        this.store.setMeta('state', 'stopped');
        return 'stopped';
      }
      this.store.setMeta('state', 'failed');
      this.store.event('run.failed', { reason: error.message });
      throw error;
    } finally {
      clearInterval(ticker);
      while (this.polling) await sleep(10);
    }
  }
  close() { this.store.close(); this.releaseLock(); }
}
