import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { goalAnchor, schemas, validate } from './schemas.mjs';
import { makePrompt } from './prompts.mjs';
import { providerFor } from './providers.mjs';
import { acquireLock, boundedJSON, hash, integer, now, readJSON, readText, sleep, sourceIdentity, writeJSON } from './util.mjs';

export const defaultRunsRoot = fileURLToPath(new URL('../runs/', import.meta.url));
export const roles = ['contract', 'contract_review', 'planner', 'worker', 'supervisor', 'triage', 'goal', 'goal_review', 'curator', 'editor'];
const nonAchievementReasons = new Set(['segment_budget_exhausted', 'goal_round_limit', 'no_progress', 'external_blocker', 'budget_exhausted']);

class AttemptBudgetError extends Error {
  constructor(limit) {
    super(`이번 실행 구간의 provider 호출 상한(${limit})에 도달했습니다.`);
    this.name = 'AttemptBudgetError';
    this.code = 'ID2A_ATTEMPT_BUDGET';
  }
}

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
    maxFailures: 2, maxControlFailures: 5, maxGoalRounds: 12, maxNoProgress: 3, maxAttempts: 100,
    contextCharacters: 12000, curatorBatch: 4, timeout: 1200,
    roleSettings: {}, ...input,
  };
  config.workspace = fs.realpathSync(config.workspace);
  if (!fs.statSync(config.workspace).isDirectory()) throw new Error('workspace는 폴더여야 합니다.');
  if (!['codex', 'claude'].includes(config.provider)) throw new Error('provider는 codex 또는 claude입니다.');
  if (!['workspace', 'yolo'].includes(config.permissions)) throw new Error('permissions는 workspace 또는 yolo입니다.');
  if (!['continue', 'wait'].includes(config.inputPolicy)) throw new Error('inputPolicy는 continue 또는 wait입니다.');
  const levels = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (!levels.includes(config.effort)) throw new Error('잘못된 effort');
  for (const [label, min, max] of [['workers', 1, 32], ['maxTasks', 1, 32], ['maxRevisions', 0, 20], ['maxFailures', 1, 10], ['maxControlFailures', 1, 20], ['maxGoalRounds', 1, 1000], ['maxNoProgress', 1, 100], ['maxAttempts', 3, 100000], ['contextCharacters', 2000, 100000], ['curatorBatch', 1, 100], ['timeout', 5, 86400]]) {
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
  writeJSON(path.join(directory, 'run.json'), { id, version: 5, created: now(), source: sourceIdentity(config.workspace), config });
  const store = new Store(directory);
  try {
    store.setMeta('state', 'created');
    store.setMeta('control', 'running');
    store.setMeta('config', config);
    store.setMeta('goal:format_version', 1);
    store.setMeta('goal:outcome', 'pending');
    store.setMeta('run:termination', null);
    store.setMeta('report:status', { state: 'not_started' });
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
    this.controlEpoch = this.store.getMeta('control:epoch', 0) || 0;
    this.initialControl = this.store.getMeta('control');
    this.controlRevision = this.store.getMeta('control:revision', 0) || 0;
    this.segmentStartAttempt = this.store.attemptCount();
    this.segmentStartGoalRound = this.store.getMeta('goal:round', 0) || 0;
    const previous = this.store.completionStatus();
    this.noProgressResumeGrace = previous.execution_state === 'suspended' && previous.termination?.reason === 'no_progress';
  }
  settings(role) {
    const inheritedRole = ['contract_review', 'goal_review'].includes(role) ? 'supervisor' : role === 'contract' ? 'planner' : role;
    const overrides = { ...(this.config.roleSettings[inheritedRole] || {}), ...(this.config.roleSettings[role] || {}) };
    const provider = overrides.provider || this.config.provider;
    return { provider,
      model: provider === this.config.provider ? this.config.model : null,
      effort: provider === this.config.provider ? this.config.effort : 'auto',
      ...overrides };
  }
  stop() {
    this.store.commitStopped('controller stop requested');
    this.abortController.abort();
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      this.config = configuration(this.store.getMeta('config', this.config));
      if (this.store.getMeta('control') === 'stopped'
          || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) this.abortController.abort();
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
  setControllerState(state) {
    let updated = false;
    this.store.transaction(() => {
      if (this.abortController.signal.aborted || this.store.getMeta('control') !== 'running'
          || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return;
      this.store.setMeta('state', state);
      updated = true;
    });
    if (!updated && (this.store.getMeta('control') === 'stopped'
        || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch)) this.abortController.abort();
    return updated;
  }
  controlLeaseLost() {
    return this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
      || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch
      || this.store.getMeta('control:lease') !== this.controlEpoch;
  }
  async runAgent(role, task, data = {}) {
    const settings = this.settings(role);
    const taskID = task?.id || null;
    // Goal finalization and reporting remain available after the ordinary segment
    // budget is spent so a long run cannot end without an explicit assessment.
    const finalizationRole = ['contract', 'contract_review', 'goal', 'goal_review', 'editor'].includes(role);
    if (!finalizationRole && this.attemptBudgetExhausted()) {
      throw new AttemptBudgetError(this.config.maxAttempts);
    }
    const attempt = this.store.beginAttempt(taskID, role, settings.provider);
    try {
      const taskDirectory = path.join(this.directory, 'tasks', taskID ? 'T' + taskID : role);
    const attemptDirectory = path.join(this.directory, 'attempts', String(attempt));
    fs.mkdirSync(taskDirectory, { recursive: true });
    fs.mkdirSync(attemptDirectory, { recursive: true });
    const instructions = this.store.messages(taskID);
    const contract = ['planner', 'worker', 'triage', 'goal', 'goal_review', 'editor'].includes(role)
      ? this.store.getMeta('goal:contract') : null;
    const promptTask = task?.result ? { ...task, result: {
      summary: task.result.summary, fact_ids: task.result.fact_ids,
      artifacts: (task.result.artifacts || []).map(artifact => ({ path: path.join(taskDirectory, 'outputs', artifact.path), bytes: Buffer.byteLength(artifact.content), sha256: hash(artifact.content) })),
    } } : task;
    const prompt = makePrompt(role, {
      goal: this.goal, task: promptTask, workspace: this.config.workspace, directory: taskDirectory,
      contract, instructions, maxTasks: this.config.maxTasks, inputPolicy: this.config.inputPolicy, ...data,
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
      const interrupted = this.controlLeaseLost();
      if (interrupted) this.abortController.abort();
      this.store.endAttempt(attempt, interrupted ? 'interrupted' : 'failed');
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
  goalSource() {
    const instructions = this.store.messages(null).map(message => ({ id: message.id, text: message.text, sha256: hash(message.text) }));
    const messageCutoff = instructions.at(-1)?.id || 0;
    const identity = { goal_sha256: hash(this.goal), instructions: instructions.map(({ id, sha256 }) => ({ id, sha256 })), message_cutoff: messageCutoff };
    return { ...identity, fingerprint: hash(JSON.stringify(identity)), effective_text: [this.goal, ...instructions.map(item => item.text)].join('\n') };
  }
  prepareContract(result, revision, source) {
    if (!result.objective.trim() || result.objective.length > 4000) throw new Error('목표 계약의 objective 형식 오류');
    if (!result.requirements.length || result.requirements.length > 32) throw new Error('목표 계약에는 1..32개의 필수 조건이 필요합니다.');
    const sourceText = source.effective_text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const seen = new Set();
    const extracted = result.requirements.map((requirement, index) => {
      const statement = requirement.statement.trim();
      const sourceReference = requirement.source_reference.trim();
      const verification = requirement.verification.trim();
      if (!statement || !sourceReference || !verification || statement.length > 3000 || sourceReference.length > 1000 || verification.length > 3000) throw new Error('목표 계약 조건의 필수 문자열 또는 길이 오류');
      if (!sourceText.includes(sourceReference.normalize('NFKC').replace(/\s+/gu, ' ').trim())) throw new Error(`목표 계약 R${index + 1}의 source_reference가 사용자 지시의 정확한 인용이 아닙니다.`);
      const identity = hash(`${requirement.type}\n${statement.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase()}`);
      if (seen.has(identity)) throw new Error('목표 계약에 중복 조건이 있습니다.');
      seen.add(identity);
      return { id: `R${index + 1}`, type: requirement.type, statement, source_reference: sourceReference, verification };
    });
    const requirements = [{ ...goalAnchor }, ...extracted];
    return {
      format_version: 1, revision, objective: result.objective.trim(), requirements,
      source: { goal_sha256: source.goal_sha256, instructions: source.instructions, message_cutoff: source.message_cutoff, fingerprint: source.fingerprint },
      created_at: now(),
    };
  }
  validateStoredContract(contract, source = this.goalSource()) {
    if (!contract || contract.format_version !== 1 || !Number.isSafeInteger(contract.revision) || contract.revision < 1
        || !contract.objective?.trim() || !Array.isArray(contract.requirements) || contract.requirements.length < 2
        || contract.source?.fingerprint !== source.fingerprint || contract.source?.goal_sha256 !== source.goal_sha256) {
      throw new Error('저장된 목표 계약의 형식 또는 원문 연결이 유효하지 않습니다.');
    }
    const expectedIDs = ['G0', ...contract.requirements.slice(1).map((_, index) => `R${index + 1}`)];
    const actualIDs = contract.requirements.map(item => item.id);
    const sourceText = source.effective_text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (new Set(actualIDs).size !== actualIDs.length || JSON.stringify(actualIDs) !== JSON.stringify(expectedIDs)
        || contract.requirements.some(item => !['outcome', 'deliverable', 'constraint'].includes(item.type)
          || !item.statement?.trim() || !item.source_reference?.trim() || !item.verification?.trim())
        || Object.entries(goalAnchor).some(([key, value]) => contract.requirements[0][key] !== value)
        || contract.requirements.slice(1).some(item => !sourceText.includes(item.source_reference.normalize('NFKC').replace(/\s+/gu, ' ').trim()))) {
      throw new Error('저장된 목표 계약의 필수 조건 집합이 유효하지 않습니다.');
    }
    const review = contract.review;
    const reviewed = Array.isArray(review?.requirement_reviews) ? review.requirement_reviews.map(item => item.requirement_id) : [];
    if (review?.decision !== 'accept' || !Array.isArray(review.missing_requirements) || !Array.isArray(review.requirement_reviews)
        || review.missing_requirements.length
        || new Set(reviewed).size !== reviewed.length || reviewed.length !== expectedIDs.length || reviewed.some(id => !expectedIDs.includes(id))
        || review.requirement_reviews.some(item => item.verdict !== 'covered')) {
      throw new Error('저장된 목표 계약에 유효한 독립 검토가 없습니다.');
    }
    return contract;
  }
  validateContractReview(contract, review) {
    const expected = contract.requirements.map(item => item.id);
    const actual = review.requirement_reviews.map(item => item.requirement_id);
    if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some(id => !expected.includes(id))) {
      throw new Error('계약 검토는 모든 조건 ID를 정확히 한 번 평가해야 합니다.');
    }
    if (review.decision === 'accept' && (review.missing_requirements.length || review.requirement_reviews.some(item => item.verdict !== 'covered'))) {
      throw new Error('누락·약화·근거 없는 조건이 있는 계약은 승인할 수 없습니다.');
    }
  }
  async ensureGoalContract() {
    let source = this.goalSource();
    const current = this.store.getMeta('goal:contract');
    if (current?.source?.fingerprint === source.fingerprint) {
      try { return this.validateStoredContract(current, source); }
      catch (error) { this.store.event('goal.contract_invalid', { revision: current?.revision, reason: error.message }); }
    }
    const revision = (Number.isSafeInteger(current?.revision) ? current.revision : 0) + 1;
    let feedback = current ? 'Later user instructions changed the effective request. Preserve unchanged requirements and apply the new instruction without weakening the goal.' : '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { result } = await this.runAgent('contract', null, {
        context: { proposed_revision: revision, previous_contract: current, controller_feedback: feedback },
        feedback,
      });
      if (this.goalSource().fingerprint !== source.fingerprint) { source = this.goalSource(); feedback = 'The user instructions changed while the contract was being prepared. Rebuild it from the current effective request.'; continue; }
      const candidate = this.prepareContract(result, revision, source);
      const { result: review } = await this.runAgent('contract_review', null, {
        candidate,
        context: { proposed_revision: revision, previous_contract: current },
      });
      this.validateContractReview(candidate, review);
      if (this.goalSource().fingerprint !== source.fingerprint) { source = this.goalSource(); feedback = 'The user instructions changed during contract review. Rebuild it from the current effective request.'; continue; }
      if (review.decision === 'revise') { feedback = JSON.stringify(review); continue; }
      const stored = { ...candidate, review: { ...review, at: now() } };
      const committed = this.store.transaction(() => {
        if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
            || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return null;
        const cutoff = Number(this.store.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE target='all'").get().id);
        if (cutoff !== source.message_cutoff) return false;
        if (Number.isSafeInteger(current?.revision)) this.store.setMeta(`goal:contract:${current.revision}`, current);
        const previousAssessment = this.store.getMeta('goal:assessment');
        const previousProgress = this.store.getMeta('goal:progress');
        if (current?.revision && previousAssessment) this.store.setMeta(`goal:assessment:${current.revision}`, previousAssessment);
        if (current?.revision && previousProgress) this.store.setMeta(`goal:progress:${current.revision}`, previousProgress);
        this.store.setMeta('goal:contract', stored);
        this.store.setMeta('goal:format_version', 1);
        this.store.setMeta('goal:outcome', 'pending');
        this.store.setMeta('goal:assessment', null);
        this.store.setMeta('goal:progress', null);
        this.store.setMeta('run:termination', null);
        this.store.setMeta('report:status', { state: current ? 'stale' : 'not_started', contract_revision: revision });
        return true;
      });
      if (committed === null) {
        this.abortController.abort();
        throw new Error('목표 계약을 저장하기 전에 컨트롤러가 중단됐습니다.');
      }
      if (!committed) { source = this.goalSource(); feedback = 'The user instructions changed before the contract was stored. Rebuild it.'; continue; }
      this.store.event('goal.contract_created', { revision, requirements: stored.requirements.map(item => item.id), source_fingerprint: source.fingerprint });
      return stored;
    }
    throw new Error('현재 사용자 지시와 일치하는 목표 계약을 확정하지 못했습니다.');
  }
  async plan() {
    if (this.store.getMeta('planned')) return;
    const existing = path.join(this.directory, 'plan.json');
    const checkPlan = plan => {
      if (plan.tasks.length > this.config.maxTasks) throw new Error('계획의 초기 작업 상한 초과');
      const seen = new Set();
      for (const [index, task] of plan.tasks.entries()) {
        if (task.depends_on.some(dependency => dependency < 0 || dependency >= index)) throw new Error('계획은 앞선 작업만 선행 작업으로 참조할 수 있습니다.');
        const identity = hash(`${task.title}\n${task.brief}\n${task.scope}`.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase());
        if (seen.has(identity)) throw new Error('계획에 중복 작업이 있습니다.');
        seen.add(identity);
      }
      return plan;
    };
    let plan = null;
    let generated = false;
    if (fs.existsSync(existing)) {
      try { plan = checkPlan(validate(readJSON(existing), schemas.planner)); }
      catch (error) {
        const quarantined = path.join(this.directory, `plan.invalid-${Date.now()}.json`);
        fs.renameSync(existing, quarantined);
        this.store.event('plan.invalidated', { reason: error.message, path: quarantined });
      }
    }
    if (!plan) {
      plan = checkPlan((await this.runAgent('planner')).result);
      generated = true;
    }
    if (generated) {
      const temporary = existing + `.tmp-${process.pid}-${crypto.randomUUID()}`;
      try {
        writeJSON(temporary, plan);
        fs.renameSync(temporary, existing);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
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
        this.store.applyVerdict(id, result, facts.map(fact => fact.id), { expectedState: 'running', taskPatch: {
          state: result.decision === 'reject' ? 'rejected' : result.decision === 'revise' ? 'stalled' : 'accepted',
          feedback: result.reason,
        } });
        return;
      }
      if (!task.result) {
        this.store.updateTask(id, { state: 'running' });
        const { result, directory } = await this.runAgent('worker', task, { context: this.store.context(task, this.config.contextCharacters), feedback: task.feedback });
        if (this.store.submitWorker(id, result, directory, this.config.workspace, { expectedState: 'running' }) === null) return;
        task = this.store.task(id);
      }
      const facts = this.store.factsForTask(id).filter(fact => task.result.fact_ids.includes(fact.id));
      this.store.checkEvidence(facts);
      const { result: verdict } = await this.runAgent('supervisor', task, { facts });
      const taskPatch = verdict.decision === 'accept' ? { state: 'accepted', feedback: verdict.reason }
        : verdict.decision === 'reject' ? { state: 'rejected', feedback: verdict.reason }
          : task.revisions >= this.config.maxRevisions ? { state: 'stalled', feedback: verdict.reason }
            : { state: 'queued', result: null, revisions: task.revisions + 1, feedback: verdict.reason };
      if (!this.store.applyVerdict(id, verdict, task.result.fact_ids, {
        expectedState: 'reviewing', taskPatch,
      })) return;
      if (verdict.decision === 'accept') {
        try { await this.followups(this.store.task(id)); }
        catch (error) {
          if (this.abortController.signal.aborted) throw error;
          if (error.code === 'ID2A_ATTEMPT_BUDGET') {
            this.store.event('followup.deferred', { task: id, reason: error.message });
          } else {
            const failures = this.recordControlFailure('followup', error);
            this.scheduleControlRetry('followup', failures, error);
            this.store.event('followup.failed', { task: id, failures, reason: error.message });
          }
        }
        this.queueConflicts();
      }
    } catch (error) {
      const task = this.store.task(id);
      if (!['running', 'reviewing'].includes(task.state)) {
        this.store.event('task.attempt_discarded', { task: id, state: task.state, reason: error.message });
        return;
      }
      const lostControl = this.controlLeaseLost();
      let patch;
      if (lostControl) {
        this.abortController.abort();
        patch = { state: task.result ? 'reviewing' : 'queued', feedback: task.feedback };
      } else if (error.code === 'ID2A_ATTEMPT_BUDGET') {
        patch = { state: task.result ? 'reviewing' : 'queued', feedback: error.message };
      } else {
        const failures = task.failures + 1;
        patch = { state: failures >= this.config.maxFailures ? 'stalled' : task.result ? 'reviewing' : 'queued', failures, feedback: error.message };
      }
      const updated = this.store.updateTask(id, patch, {
        expectedState: task.state, expectedControlEpoch: this.controlEpoch, allowStopped: lostControl,
      });
      if (!updated) {
        this.store.event('task.attempt_discarded', { task: id, state: this.store.task(id).state, reason: error.message });
      } else if (error.code === 'ID2A_ATTEMPT_BUDGET') {
        this.store.event('task.deferred', { task: id, reason: 'attempt_budget', detail: error.message });
      }
    }
  }
  async followups(task) {
    const generation = this.followupGeneration(task);
    if (this.followupsComplete(task, generation)) return;
    for (const candidate of task.result.followups) {
      const signature = hash(`${task.id}\n${generation}\n${candidate.title}\n${candidate.brief}\n${candidate.scope}`);
      let result = this.store.getMeta('triage:' + signature);
      const recovered = Boolean(result);
      if (!result) {
        ({ result } = await this.runAgent('triage', task, { candidate, context: this.store.context(task, this.config.contextCharacters) }));
        this.store.setMeta('triage:' + signature, result);
      }
      if (result.decision === 'approve') {
        const existing = this.store.existingTask(candidate);
        let id = existing;
        if (existing) {
          const prior = this.store.task(existing);
          if (['stalled', 'rejected', 'blocked', 'cancelled'].includes(prior.state)) {
            if (prior.dependencies.length === 1 && prior.dependencies[0] === task.id) {
              this.store.updateTask(existing, { state: 'queued', result: null, revisions: 0, failures: 0,
                feedback: `후속 작업 세대 ${generation.slice(0, 12)}에서 다시 승인됐습니다.` });
            } else {
              const generatedSignature = hash(`followup:${generation}\n${candidate.title}\n${candidate.brief}\n${candidate.scope}`);
              id = this.store.taskWithSignature(generatedSignature)
                || this.store.addTask(candidate, { dependencies: [task.id], signature: generatedSignature });
            }
          }
        } else id = this.store.addTask(candidate, { dependencies: [task.id] });
        this.store.event('followup.approved', { task: task.id, followup: id, title: candidate.title,
          reason: result.reason, recovered: recovered || Boolean(existing) });
      } else this.store.event('followup.rejected', { task: task.id, title: candidate.title, reason: result.reason });
    }
    this.store.transaction(() => {
      this.store.setMeta('followups:generation:' + task.id, generation);
      this.store.setMeta('followups:' + task.id, true);
    });
  }
  followupGeneration(task) {
    return this.store.followupGeneration(task);
  }
  followupsComplete(task, generation = this.followupGeneration(task)) {
    return this.store.followupsComplete(task, generation);
  }
  hasPendingFollowups() {
    return this.store.tasks().some(task => task.state === 'accepted' && task.kind === 'work'
      && task.result?.followups?.length && !this.followupsComplete(task));
  }
  pendingTasks() {
    return this.store.tasks().filter(task => ['queued', 'reviewing', 'running'].includes(task.state));
  }
  async recoverAcceptedFollowups() {
    const pending = this.store.tasks().filter(item => item.state === 'accepted' && item.kind === 'work'
      && item.result && !this.followupsComplete(item));
    if (pending.length && !await this.honorStoredControlRetry('followup')) return false;
    for (const task of pending) {
      try {
        await this.followups(task);
      } catch (error) {
        if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
            || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) {
          this.abortController.abort();
          throw error;
        }
        this.store.event(error.code === 'ID2A_ATTEMPT_BUDGET' ? 'followup.deferred' : 'followup.failed', {
          task: task.id, segment: this.store.getMeta('run:segment', 0) || 0, reason: error.message,
        });
        if (error.code !== 'ID2A_ATTEMPT_BUDGET') {
          const failures = this.recordControlFailure('followup', error);
          await this.waitForControlRetry('followup', failures, error);
        }
        return false;
      }
    }
    if (pending.length) this.resetControlFailures('followup');
    return true;
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
    const evidence = this.store.evidenceStatus(view);
    const budget = Math.floor(this.config.contextCharacters * 0.4);
    const ordered = tasks.toReversed().sort((a, b) => Number(a.state === 'accepted') - Number(b.state === 'accepted'));
    const { items: compactTasks, ...taskCoverage } = boundedJSON(ordered.map(task => this.store.taskRecord(task)), budget);
    compactTasks.sort((a, b) => a.id - b.id);
    const { items: compactFacts, ...factCoverage } = boundedJSON(verified.toReversed().map(({ id, key, scope, kind, claim }) => ({ id, key, scope, kind, claim,
      current_evidence: evidence.facts[id] === true })), budget);
    compactFacts.reverse();
    const knowledge = this.store.knowledgeContext(view, this.config.contextCharacters - budget * 2);
    const coverage = { ...knowledge.coverage, tasks: taskCoverage, facts: { ...factCoverage, state: 'verified',
      current_evidence: Object.values(evidence.facts).filter(Boolean).length } };
    const counts = {};
    for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
    return { tasks, verified, conflicted, compactTasks, compactFacts, counts, knowledge, coverage, snapshot,
      evidenceSnapshot: evidence.snapshot, currentFactIDs: new Set(Object.entries(evidence.facts).filter(([, current]) => current).map(([id]) => Number(id))) };
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
      if (dependencies.some(dependency => !Number.isSafeInteger(dependency))) {
        ids.push(null);
        this.store.event('goal.task_skipped', { round, title: candidate.title, reason: 'excluded_dependency' });
        continue;
      }
      const brief = { title: candidate.title, brief: candidate.brief, scope: candidate.scope };
      const same = this.store.tasks().filter(task => task.title === candidate.title && task.brief === candidate.brief && task.scope === candidate.scope).at(-1);
      if (same?.state === 'accepted') { ids.push(same.id); continue; }
      if (same && terminal.has(same.state) && JSON.stringify(same.dependencies) === JSON.stringify(dependencies)) {
        ids.push(null);
        this.store.event('goal.task_skipped', { round, task: same.id, title: candidate.title, reason: 'exhausted_duplicate' });
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
  messageCutoff() {
    return Number(this.store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id);
  }
  completionCandidate(view, contract) {
    const source = this.goalSource();
    return {
      ledger_snapshot: view.snapshot,
      evidence_snapshot: view.evidenceSnapshot,
      message_cutoff: this.messageCutoff(),
      contract_hash: hash(JSON.stringify(contract)),
      contract_revision: contract.revision,
      goal_source_fingerprint: source.fingerprint,
      control_epoch: this.controlEpoch,
    };
  }
  candidateIsCurrent(candidate) {
    const contract = this.store.getMeta('goal:contract');
    const view = this.store.ledgerView();
    const source = this.goalSource();
    return this.store.getMeta('control') === 'running'
      && (this.store.getMeta('control:epoch', 0) || 0) === candidate.control_epoch
      && candidate.goal_source_fingerprint === source.fingerprint
      && contract?.source?.fingerprint === source.fingerprint
      && view.snapshot === candidate.ledger_snapshot
      && this.store.evidenceStatus(view).snapshot === candidate.evidence_snapshot
      && this.messageCutoff() === candidate.message_cutoff
      && hash(JSON.stringify(contract)) === candidate.contract_hash;
  }
  attemptBudgetUsed() {
    return Math.max(0, this.store.attemptCount() - this.segmentStartAttempt);
  }
  attemptBudgetExhausted() {
    return this.attemptBudgetUsed() >= this.config.maxAttempts;
  }
  goalRoundBudgetExhausted(round = this.store.getMeta('goal:round', 0) || 0) {
    return Math.max(0, round - this.segmentStartGoalRound) >= this.config.maxGoalRounds;
  }
  reusableTerminalOutcome(status) {
    if (!['completed', 'suspended'].includes(status.execution_state)
        || !['achieved', 'not_established'].includes(status.goal_outcome)
        || (status.goal_outcome === 'achieved' && status.execution_state !== 'completed')
        || (status.goal_outcome === 'not_established' && status.execution_state !== 'suspended')) return null;
    const savedCandidate = this.store.getMeta('goal:candidate');
    const assessment = this.store.getMeta('goal:assessment');
    if (!savedCandidate || !assessment) return null;
    try {
      const contract = this.validateStoredContract(this.store.getMeta('goal:contract'), this.goalSource());
      const view = this.goalContext();
      const candidate = this.completionCandidate(view, contract);
      if (JSON.stringify(candidate) !== JSON.stringify(savedCandidate)) return null;
      const expected = contract.requirements.map(item => item.id);
      const evaluated = assessment.requirement_evaluations?.map(item => item.requirement_id) || [];
      if (assessment.contract_revision !== contract.revision || new Set(evaluated).size !== evaluated.length
          || evaluated.length !== expected.length || evaluated.some(id => !expected.includes(id))) return null;
      if (status.goal_outcome === 'achieved') {
        this.validateGoalAssessment(assessment, contract, view);
        this.validateGoalReview(assessment.independent_review, contract);
        return { kind: 'achieved', assessment, candidate };
      }
      if (assessment.decision !== 'concluded' || !nonAchievementReasons.has(status.termination?.reason)) return null;
      return { kind: 'concluded', assessment, candidate, terminationReason: status.termination.reason };
    } catch { return null; }
  }
  pendingTerminalOutcome() {
    const pending = this.store.getMeta('goal:pending_terminal');
    if (!pending || !['achieved', 'concluded'].includes(pending.kind) || !pending.assessment || !pending.candidate) return null;
    try {
      const contract = this.validateStoredContract(this.store.getMeta('goal:contract'), this.goalSource());
      const view = this.goalContext();
      const candidate = this.completionCandidate(view, contract);
      if (JSON.stringify(candidate) !== JSON.stringify(pending.candidate)) return null;
      const expected = contract.requirements.map(item => item.id);
      const evaluated = pending.assessment.requirement_evaluations?.map(item => item.requirement_id) || [];
      if (pending.assessment.contract_revision !== contract.revision || new Set(evaluated).size !== evaluated.length
          || evaluated.length !== expected.length || evaluated.some(id => !expected.includes(id))) return null;
      if (pending.kind === 'achieved') {
        this.validateGoalAssessment(pending.assessment, contract, view);
        this.validateGoalReview(pending.assessment.independent_review, contract);
      } else if (pending.assessment.decision !== 'concluded' || !nonAchievementReasons.has(pending.terminationReason)) return null;
      return pending;
    } catch { return null; }
  }
  terminalLimitStillApplies(outcome) {
    // A new Engine invocation is an explicit resume request and grants a fresh
    // execution segment. Only an already approved achievement is terminal.
    return outcome.kind === 'achieved';
  }
  completedReportIsCurrent(status) {
    if (status.report?.state !== 'complete' || !status.report.id) return false;
    const reportPath = status.report.path || path.join(this.directory, 'report.md');
    const resultPath = path.join(this.directory, 'result.json');
    try {
      const result = readJSON(resultPath);
      return fs.statSync(reportPath).isFile() && result.report?.state === 'complete'
        && result.report.id === status.report.id && result.goal_outcome === status.goal_outcome;
    } catch { return false; }
  }
  controlFailureState(stage) {
    const value = this.store.getMeta(`control:failures:${stage}`, { count: 0 });
    return typeof value === 'number' ? { count: value } : value;
  }
  controlFailureContext(stage) {
    const roleMap = {
      contract: ['contract', 'contract_review'],
      plan: ['planner'],
      goal: ['contract', 'contract_review', 'goal', 'goal_review'],
      followup: ['triage'],
    };
    return hash(JSON.stringify({
      source: this.goalSource().fingerprint,
      roles: (roleMap[stage] || []).map(role => [role, this.settings(role)]),
      timeout: this.config.timeout,
      permissions: this.config.permissions,
      inputPolicy: this.config.inputPolicy,
      codexBin: this.config.codexBin || null,
      claudeBin: this.config.claudeBin || null,
    }));
  }
  assertControlBudget(stage) {
    const state = this.controlFailureState(stage);
    const sourceFingerprint = this.goalSource().fingerprint;
    const contextFingerprint = this.controlFailureContext(stage);
    if ((state.context_fingerprint && state.context_fingerprint !== contextFingerprint)
        || (!state.context_fingerprint && state.source_fingerprint && state.source_fingerprint !== sourceFingerprint)) {
      this.store.setMeta(`control:failures:${stage}`, { count: 0, source_fingerprint: sourceFingerprint,
        context_fingerprint: contextFingerprint, reset_at: now() });
    }
  }
  recordControlFailure(stage, error) {
    const previous = this.controlFailureState(stage);
    const sourceFingerprint = this.goalSource().fingerprint;
    const contextFingerprint = this.controlFailureContext(stage);
    const sameContext = previous.context_fingerprint
      ? previous.context_fingerprint === contextFingerprint
      : !previous.source_fingerprint || previous.source_fingerprint === sourceFingerprint;
    const state = { count: sameContext ? (previous.count || 0) + 1 : 1, source_fingerprint: sourceFingerprint,
      context_fingerprint: contextFingerprint, reason: error.message, at: now() };
    this.store.setMeta(`control:failures:${stage}`, state);
    return state.count;
  }
  resetControlFailures(stage) {
    this.store.setMeta(`control:failures:${stage}`, { count: 0, source_fingerprint: this.goalSource().fingerprint,
      context_fingerprint: this.controlFailureContext(stage), reset_at: now() });
    this.store.setMeta(`control:retry:${stage}`, null);
  }
  beginSegment(reason = 'controller_started', checkpoint = null, eventType = 'run.segment_advanced') {
    if (this.abortController.signal.aborted) return null;
    const segment = (this.store.getMeta('run:segment', 0) || 0) + 1;
    const startAttempt = this.store.attemptCount();
    const startGoalRound = this.store.getMeta('goal:round', 0) || 0;
    const startedAt = now();
    const previous = this.store.getMeta('run:segment_state');
    const checkpointRecord = checkpoint ? {
      segment: previous?.id || Math.max(0, segment - 1), reason,
      assessment: Object.hasOwn(checkpoint, 'assessment') ? checkpoint.assessment : this.store.getMeta('goal:assessment'),
      assessment_status: checkpoint.assessmentStatus || (checkpoint.assessment ? 'evaluated' : 'assessment_not_run'),
      candidate: checkpoint.candidate || null,
      attempt_count: startAttempt, attempts_used: Math.max(0, startAttempt - (previous?.start_attempt ?? startAttempt)),
      goal_round: startGoalRound, goal_rounds_used: Math.max(0, startGoalRound - (previous?.start_goal_round ?? startGoalRound)), at: startedAt,
    } : null;
    const state = { id: segment, start_attempt: startAttempt, start_goal_round: startGoalRound,
      reason, phase: 'running', started_at: startedAt };
    let replan = null;
    let resetProgress = null;
    if (reason === 'no_progress') {
      const previousReplan = this.store.getMeta('goal:replan', { generation: 0 });
      const allExcludedTaskIDs = this.store.tasks()
        .filter(task => ['stalled', 'rejected', 'blocked', 'cancelled'].includes(task.state))
        .map(task => task.id);
      const excludedTaskIDs = allExcludedTaskIDs.slice(-64);
      const progress = this.store.getMeta('goal:progress');
      replan = { generation: (previousReplan.generation || 0) + 1,
        last_trigger_round: startGoalRound, reason, status: 'pending', excluded_task_ids: excludedTaskIDs,
        excluded_task_coverage: { total: allExcludedTaskIDs.length, included: excludedTaskIDs.length,
          truncated: excludedTaskIDs.length < allExcludedTaskIDs.length }, at: startedAt };
      if (progress) resetProgress = { ...progress, stagnant: 0,
        strategy_generation: replan.generation, strategy_reset_at: startedAt };
    }
    let committed = false;
    this.store.transaction(() => {
      if (this.abortController.signal.aborted || this.store.getMeta('control') !== 'running'
          || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return;
      if (checkpointRecord) this.store.setMeta('run:last_checkpoint', checkpointRecord);
      this.store.setMeta('run:segment', segment);
      this.store.setMeta('run:segment_state', state);
      this.store.setMeta('state', 'running');
      this.store.setMeta('goal:outcome', 'pending');
      this.store.setMeta('run:termination', null);
      this.store.setMeta('goal:pending_terminal', null);
      if (replan) {
        this.store.setMeta('goal:replan', replan);
        if (resetProgress) this.store.setMeta('goal:progress', resetProgress);
        this.store.setMeta('goal:feedback', '진전이 없는 접근을 반복하지 말고, 아직 충족되지 않은 조건을 겨냥한 다른 검증·구현 경로와 실행 가능한 새 작업을 제안하세요.');
      }
      committed = true;
    });
    if (!committed) {
      if (this.store.getMeta('control') === 'stopped') this.abortController.abort();
      return null;
    }
    this.segmentStartAttempt = startAttempt;
    this.segmentStartGoalRound = startGoalRound;
    if (replan) {
      this.noProgressResumeGrace = true;
      this.store.event('goal.strategy_replanned', { generation: replan.generation,
        round: startGoalRound, excluded_tasks: replan.excluded_task_ids,
        excluded_task_coverage: replan.excluded_task_coverage });
    }
    this.store.event(eventType, { run: this.manifest.id, segment, reason,
      previous_segment: previous?.id || null, segment_start_attempt: startAttempt,
      max_attempts: this.config.maxAttempts, segment_start_goal_round: startGoalRound,
      max_goal_rounds: this.config.maxGoalRounds });
    return state;
  }
  setSegmentPhase(phase, extra = {}) {
    const state = this.store.getMeta('run:segment_state');
    if (state) this.store.setMeta('run:segment_state', { ...state, phase, ...extra });
  }
  scheduleControlRetry(stage, failures, error) {
    const delay = Math.min(30000, 1000 * (2 ** Math.min(failures - 1, 5)));
    const retryAt = new Date(Date.now() + delay).toISOString();
    const contextFingerprint = this.controlFailureContext(stage);
    let scheduled = false;
    this.store.transaction(() => {
      if (this.abortController.signal.aborted || this.store.getMeta('control') !== 'running'
          || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return;
      this.store.setMeta('state', 'retrying');
      this.store.setMeta(`control:retry:${stage}`, { failures, reason: error.message, retry_at: retryAt,
        context_fingerprint: contextFingerprint, at: now() });
      scheduled = true;
    });
    if (!scheduled) {
      if (this.store.getMeta('control') === 'stopped') this.abortController.abort();
      return null;
    }
    this.store.event('control.retry_scheduled', { stage, failures, reason: error.message, retry_at: retryAt });
    return { deadline: Date.parse(retryAt), contextFingerprint };
  }
  async waitForControlRetry(stage, failures, error, { rollover = true } = {}) {
    const attemptBoundary = this.attemptBudgetExhausted();
    if (rollover && (attemptBoundary || failures % this.config.maxControlFailures === 0) && !this.abortController.signal.aborted) {
      this.beginSegment(attemptBoundary ? 'segment_budget_exhausted' : `${stage}_control_failure_window`, {
        assessment: null,
        assessmentStatus: 'assessment_not_run',
        candidate: null,
      });
    }
    if (this.abortController.signal.aborted) return;
    const retry = this.scheduleControlRetry(stage, failures, error);
    if (!retry) return;
    const { deadline, contextFingerprint } = retry;
    while (!this.abortController.signal.aborted && Date.now() < deadline) {
      await this.poll();
      if (this.controlFailureContext(stage) !== contextFingerprint) break;
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    this.store.transaction(() => {
      if (!this.abortController.signal.aborted && this.store.getMeta('control') === 'running'
          && (this.store.getMeta('control:epoch', 0) || 0) === this.controlEpoch) this.store.setMeta('state', 'running');
    });
  }
  async honorStoredControlRetry(stage) {
    const retry = this.store.getMeta(`control:retry:${stage}`);
    if (!retry) return !this.abortController.signal.aborted && this.store.getMeta('control') === 'running'
      && (this.store.getMeta('control:epoch', 0) || 0) === this.controlEpoch;
    const contextFingerprint = this.controlFailureContext(stage);
    if (retry.context_fingerprint !== contextFingerprint) {
      this.store.setMeta(`control:retry:${stage}`, null);
      return !this.abortController.signal.aborted && this.store.getMeta('control') === 'running'
        && (this.store.getMeta('control:epoch', 0) || 0) === this.controlEpoch;
    }
    const deadline = Date.parse(retry.retry_at);
    if (Number.isFinite(deadline) && deadline > Date.now()) {
      let waiting = false;
      this.store.transaction(() => {
        if (this.abortController.signal.aborted || this.store.getMeta('control') !== 'running'
            || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return;
        this.store.setMeta('state', 'retrying');
        waiting = true;
      });
      if (!waiting) {
        if (this.store.getMeta('control') === 'stopped') this.abortController.abort();
        return false;
      }
      this.store.event('control.retry_resumed', { stage, failures: retry.failures, retry_at: retry.retry_at });
      while (!this.abortController.signal.aborted && Date.now() < deadline) {
        await this.poll();
        if (this.controlFailureContext(stage) !== contextFingerprint) break;
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
    let running = false;
    this.store.transaction(() => {
      this.store.setMeta(`control:retry:${stage}`, null);
      running = !this.abortController.signal.aborted && this.store.getMeta('control') === 'running'
        && (this.store.getMeta('control:epoch', 0) || 0) === this.controlEpoch;
      if (running) this.store.setMeta('state', 'running');
    });
    return running;
  }
  attemptBudgetCheckpoint() {
    const round = this.store.getMeta('goal:round', 0);
    let contract;
    try { contract = this.validateStoredContract(this.store.getMeta('goal:contract'), this.goalSource()); }
    catch (error) {
      this.store.event('goal.checkpoint_context_changed', { round, reason: error.message,
        boundary: 'segment_budget_exhausted' });
      return { kind: 'checkpoint', assessment: null, assessmentStatus: 'context_changed',
        terminationReason: 'context_changed', candidate: null };
    }
    const view = this.goalContext();
    const previous = this.store.getMeta('goal:assessment');
    const expected = contract.requirements.map(requirement => requirement.id);
    const evaluated = previous?.requirement_evaluations?.map(item => item.requirement_id) || [];
    const assessedThisSegment = previous?.contract_revision === contract.revision
      && previous.round > this.segmentStartGoalRound
      && evaluated.length === expected.length && new Set(evaluated).size === evaluated.length
      && evaluated.every(id => expected.includes(id));
    const reason = `이번 실행 구간의 provider 호출 상한(${this.config.maxAttempts})에 도달했습니다. 체크포인트를 저장하고 다음 실행 구간을 자동으로 시작합니다.`;
    const assessment = assessedThisSegment ? previous : null;
    const candidate = this.completionCandidate(view, contract);
    this.store.event('goal.checkpointed', { round, reason: 'segment_budget_exhausted', detail: reason,
      assessment_status: assessedThisSegment ? 'evaluated' : 'assessment_not_run', lifetime_attempts: this.store.attemptCount(),
      segment_attempts: this.attemptBudgetUsed(), limit: this.config.maxAttempts });
    return { kind: 'checkpoint', assessment, assessmentStatus: assessedThisSegment ? 'evaluated' : 'assessment_not_run',
      terminationReason: 'segment_budget_exhausted', candidate };
  }
  goalRoundBudgetCheckpoint() {
    const round = this.store.getMeta('goal:round', 0);
    let contract;
    try { contract = this.validateStoredContract(this.store.getMeta('goal:contract'), this.goalSource()); }
    catch (error) {
      this.store.event('goal.checkpoint_context_changed', { round, reason: error.message,
        boundary: 'goal_round_limit' });
      return { kind: 'checkpoint', assessment: null, assessmentStatus: 'context_changed',
        terminationReason: 'context_changed', candidate: null };
    }
    const view = this.goalContext();
    const previous = this.store.getMeta('goal:assessment');
    const expected = contract.requirements.map(requirement => requirement.id);
    const evaluated = previous?.requirement_evaluations?.map(item => item.requirement_id) || [];
    const validPrevious = previous?.contract_revision === contract.revision
      && evaluated.length === expected.length && new Set(evaluated).size === evaluated.length
      && evaluated.every(id => expected.includes(id));
    const reason = `이번 실행 구간의 Goal 판정 상한(${this.config.maxGoalRounds})에 도달했습니다. 체크포인트를 저장하고 다음 실행 구간을 자동으로 시작합니다.`;
    const assessment = validPrevious ? previous : null;
    const candidate = this.completionCandidate(view, contract);
    this.store.event('goal.checkpointed', { round, reason: 'goal_round_limit', detail: reason,
      segment_rounds: Math.max(0, round - this.segmentStartGoalRound), lifetime_rounds: round, limit: this.config.maxGoalRounds });
    return { kind: 'checkpoint', assessment, assessmentStatus: validPrevious ? 'evaluated' : 'assessment_not_run',
      terminationReason: 'goal_round_limit', candidate };
  }
  async segmentBudgetOutcome() {
    const pendingWork = this.store.tasks().some(task => ['queued', 'reviewing', 'running'].includes(task.state))
      || this.hasPendingFollowups();
    if (this.store.getMeta('planned') && !pendingWork && !this.goalRoundBudgetExhausted()) {
      try {
        if (!await this.honorStoredControlRetry('goal')) return { kind: 'changed' };
        this.assertControlBudget('goal');
        await this.ensureGoalContract();
        if (this.pendingTasks().length || this.hasPendingFollowups()) return this.attemptBudgetCheckpoint();
        const checkpoint = await this.assessGoal();
        this.resetControlFailures('goal');
        if (['achieved', 'checkpoint', 'waiting', 'changed'].includes(checkpoint.kind)) return checkpoint;
        this.store.event('goal.segment_checkpoint', { kind: checkpoint.kind,
          round: this.store.getMeta('goal:round', 0), segment_attempts: this.attemptBudgetUsed() });
      } catch (error) {
        if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
            || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) {
          this.abortController.abort();
          throw error;
        }
        const failures = error.code === 'ID2A_ATTEMPT_BUDGET' ? null : this.recordControlFailure('goal', error);
        this.store.event('goal.segment_checkpoint_failed', { reason: error.message, ...(failures === null ? {} : { failures }) });
        if (failures !== null) await this.waitForControlRetry('goal', failures, error, { rollover: false });
      }
    }
    return this.attemptBudgetCheckpoint();
  }
  validateGoalAssessment(result, contract, view) {
    if (result.contract_revision !== contract.revision) throw new Error('목표 판정의 계약 revision이 현재 계약과 다릅니다.');
    const expected = contract.requirements.map(item => item.id);
    const actual = result.requirement_evaluations.map(item => item.requirement_id);
    if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some(id => !expected.includes(id))) {
      throw new Error('목표 판정은 모든 필수 조건 ID를 정확히 한 번 평가해야 합니다.');
    }
    const verifiedIDs = new Set(view.verified.map(fact => fact.id));
    for (const evaluation of result.requirement_evaluations) {
      if (!evaluation.reason.trim()) throw new Error(`${evaluation.requirement_id}: 판정 이유가 비어 있습니다.`);
      if (new Set(evaluation.fact_ids).size !== evaluation.fact_ids.length || evaluation.fact_ids.some(id => !verifiedIDs.has(id))) {
        throw new Error(`${evaluation.requirement_id}: 현재 검증되지 않은 사실을 인용했습니다.`);
      }
      if (evaluation.fact_ids.some(id => !view.currentFactIDs.has(id))) throw new Error(`${evaluation.requirement_id}: 현재 원본과 일치하지 않는 오래된 사실을 인용했습니다.`);
      if (evaluation.verdict === 'satisfied' && !evaluation.fact_ids.length) throw new Error(`${evaluation.requirement_id}: 충족 판정에는 현재 검증 근거가 필요합니다.`);
    }
    if (result.next_tasks.length > this.config.maxTasks) throw new Error('목표 판정의 다음 작업 수가 사이클 상한을 초과했습니다.');
    const allSatisfied = result.requirement_evaluations.every(item => item.verdict === 'satisfied');
    if (result.decision === 'achieved' && (!allSatisfied || result.next_tasks.length || result.question.trim())) throw new Error('달성 판정에는 모든 필수 조건의 충족, 빈 다음 작업, 빈 질문이 필요합니다.');
    if (result.decision === 'continue' && (allSatisfied || !result.next_tasks.length || result.question.trim())) throw new Error('계속 판정에는 미충족 조건, 하나 이상의 다음 작업, 빈 질문이 필요합니다.');
    if (result.decision === 'needs_input' && (allSatisfied || result.next_tasks.length || !result.question.trim())) throw new Error('입력 대기 판정에는 미충족 조건과 다음 작업 없는 정확한 질문이 필요합니다.');
    if (result.decision === 'achieved' && view.conflicted.length) throw new Error('해결되지 않은 사실 충돌이 있으면 목표 달성을 승인할 수 없습니다.');
  }
  validateGoalReview(review, contract) {
    if (review.contract_revision !== contract.revision) throw new Error('독립 완료 검토의 계약 revision이 현재 계약과 다릅니다.');
    const expected = contract.requirements.map(item => item.id);
    const actual = review.requirement_reviews.map(item => item.requirement_id);
    if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some(id => !expected.includes(id))) {
      throw new Error('독립 완료 검토는 모든 필수 조건 ID를 정확히 한 번 평가해야 합니다.');
    }
    if (review.decision === 'accept' && review.requirement_reviews.some(item => item.verdict !== 'accept')) throw new Error('거절된 조건이 있는 완료 후보는 승인할 수 없습니다.');
    if (review.decision === 'reject' && review.requirement_reviews.every(item => item.verdict === 'accept')) throw new Error('완료 후보 거절에는 하나 이상의 거절된 조건이 필요합니다.');
  }
  progressState(assessment) {
    const current = assessment.requirement_evaluations
      .map(item => [item.requirement_id, item.verdict, [...item.fact_ids].sort((a, b) => a - b)])
      .sort((left, right) => left[0].localeCompare(right[0]));
    const signature = hash(JSON.stringify(current));
    const previous = this.store.getMeta('goal:progress');
    const previousSeen = previous?.seen && typeof previous.seen === 'object' ? previous.seen : {};
    const currentByID = new Map(current.map(item => [item[0], item]));
    const seen = {};
    let progressed = false;
    for (const requirementID of [...new Set([...Object.keys(previousSeen), ...currentByID.keys()])].sort()) {
      const prior = previousSeen[requirementID] || {};
      const verdicts = new Set(Array.isArray(prior.verdicts) ? prior.verdicts : []);
      const factIDs = new Set(Array.isArray(prior.fact_ids) ? prior.fact_ids : []);
      const evaluation = currentByID.get(requirementID);
      if (evaluation) {
        if (!verdicts.has(evaluation[1])) progressed = true;
        verdicts.add(evaluation[1]);
        for (const factID of evaluation[2]) {
          if (!factIDs.has(factID)) progressed = true;
          factIDs.add(factID);
        }
      }
      seen[requirementID] = {
        verdicts: [...verdicts].sort(),
        fact_ids: [...factIDs].sort((a, b) => a - b),
      };
    }
    const priorStagnant = Number.isSafeInteger(previous?.stagnant) && previous.stagnant >= 0 ? previous.stagnant : 0;
    const stagnant = progressed ? 0 : priorStagnant + 1;
    const state = { signature, seen, progressed, stagnant, round: assessment.round, at: now() };
    this.store.setMeta('goal:progress', state);
    return state;
  }
  noProgressLimitReached(progress) {
    if (progress.stagnant < this.config.maxNoProgress) return false;
    if (!this.noProgressResumeGrace) return true;
    this.noProgressResumeGrace = false;
    this.store.event('goal.no_progress_resume_grace', { round: progress.round, stagnant: progress.stagnant });
    return false;
  }
  concludeAssessment(assessment, terminationReason, candidate) {
    this.store.event('goal.checkpointed', { round: assessment.round, reason: terminationReason, detail: assessment.reason });
    return { kind: 'checkpoint', assessment, assessmentStatus: 'evaluated', terminationReason, candidate };
  }
  async assessGoal() {
    let contract;
    try { contract = this.validateStoredContract(this.store.getMeta('goal:contract'), this.goalSource()); }
    catch (error) {
      this.store.event('goal.changed_before_assessment', { reason: error.message });
      return { kind: 'changed' };
    }
    const beforeMessage = this.messageCutoff();
    const round = this.store.getMeta('goal:round', 0) + 1;
    const view = this.goalContext();
    const candidate = this.completionCandidate(view, contract);
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
        replan: this.store.getMeta('goal:replan'),
        current_source: sourceIdentity(this.config.workspace),
      },
    });
    if (beforeMessage !== this.messageCutoff() || !this.candidateIsCurrent(candidate)) {
      this.store.event('goal.changed_during_review', { round });
      return { kind: 'changed' };
    }
    this.validateGoalAssessment(result, contract, view);
    let assessment = { ...result,
      fact_ids: [...new Set(result.requirement_evaluations.flatMap(item => item.fact_ids))].sort((a, b) => a - b),
      round, at: now() };
    if (result.decision === 'needs_input' && this.config.inputPolicy === 'continue') {
      const feedback = `무인 연속 실행 정책에서는 사용자 입력을 기다릴 수 없습니다. 질문(${result.question})은 차단 사유가 아닙니다. 범위·기준선·우선순위·검증 방법처럼 되돌릴 수 있는 선택은 가장 안전하고 제한적인 합리적 기본값을 채택해 가정으로 기록하고, 실제 작업을 수행할 다음 작업을 제안하세요. 외부 자원이 없으면 가능한 우회·대체 검증·부분 구현을 시도하세요.`;
      this.store.setMeta('goal:round', round);
      this.store.setMeta('goal:assessment', assessment);
      this.store.setMeta('goal:feedback', feedback);
      if (!this.setControllerState('running')) return { kind: 'changed' };
      this.store.event('goal.input_bypassed', { round, question: result.question, reason: result.reason });
      const progress = this.progressState(assessment);
      if (this.noProgressLimitReached(progress)) return this.concludeAssessment(assessment, 'no_progress', candidate);
      if (this.goalRoundBudgetExhausted(round)) return this.concludeAssessment(assessment, 'goal_round_limit', candidate);
      return { kind: 'retry' };
    }
    this.store.setMeta('goal:round', round);
    this.store.setMeta('goal:assessment', assessment);
    this.store.setMeta('goal:feedback', '');
    this.store.event('goal.assessed', { round, decision: result.decision, reason: result.reason, progress: result.progress });
    if (result.decision === 'achieved') {
      const { result: review } = await this.runAgent('goal_review', null, {
        facts: view.compactFacts,
        candidate: assessment,
        context: { ...view.knowledge, coverage: view.coverage, tasks: view.compactTasks,
          conflicts: view.conflicted.map(({ id, key, claim }) => ({ id, key, claim })) },
      });
      this.validateGoalReview(review, contract);
      if (!this.candidateIsCurrent(candidate)) {
        this.store.event('goal.changed_during_review', { round, stage: 'independent_review' });
        return { kind: 'changed' };
      }
      assessment = { ...assessment, independent_review: { ...review, at: now() } };
      this.store.setMeta('goal:assessment', assessment);
      if (review.decision === 'reject') {
        this.store.setMeta('goal:feedback', `독립 완료 검토가 달성 후보를 거절했습니다: ${review.reason}`);
        this.store.event('goal.achievement_rejected', { round, reason: review.reason });
        const progress = this.progressState(assessment);
        if (this.noProgressLimitReached(progress)) return this.concludeAssessment(assessment, 'no_progress', candidate);
        if (this.goalRoundBudgetExhausted(round)) return this.concludeAssessment(assessment, 'goal_round_limit', candidate);
        return { kind: 'retry' };
      }
      return { kind: 'achieved', assessment, candidate };
    }
    if (result.decision === 'needs_input') {
      if (!this.setControllerState('waiting_input')) return { kind: 'changed' };
      this.store.event('goal.waiting_input', { round, question: result.question });
      return { kind: 'waiting', marker: beforeMessage };
    }
    const progress = this.progressState(assessment);
    const scheduled = this.queueGoalTasks(result.next_tasks, round, result.reason);
    if (this.noProgressLimitReached(progress)) {
      if (scheduled.length) this.store.event('goal.replan_tasks_preserved', { round, tasks: scheduled });
      const checkpointCandidate = scheduled.length ? this.completionCandidate(this.goalContext(), contract) : candidate;
      return this.concludeAssessment(assessment, 'no_progress', checkpointCandidate);
    }
    if (!scheduled.length) {
      const feedback = '계속 판정이 실행 가능한 새 작업을 만들지 못했습니다. 완료된 작업을 반복하지 말고 다른 구체적 접근을 제안하세요.';
      this.store.setMeta('goal:feedback', feedback);
      this.store.event('goal.replan_required', { round, reason: feedback });
      return { kind: 'retry' };
    }
    if (!this.setControllerState('running')) return { kind: 'changed' };
    this.noProgressResumeGrace = false;
    const replan = this.store.getMeta('goal:replan');
    if (replan?.status === 'pending') this.store.setMeta('goal:replan', { ...replan, status: 'scheduled', tasks: scheduled, scheduled_at: now() });
    this.store.event('goal.continued', { round, tasks: scheduled });
    if (this.goalRoundBudgetExhausted(round)) {
      const queuedCandidate = this.completionCandidate(this.goalContext(), contract);
      return this.concludeAssessment(assessment, 'goal_round_limit', queuedCandidate);
    }
    return { kind: 'continue', tasks: scheduled };
  }
  async waitForInstruction(marker) {
    while (!this.abortController.signal.aborted) {
      await this.poll();
      if (this.store.getMeta('control') === 'paused') { await sleep(300); continue; }
      if (this.store.readyTasks().length || this.messageCutoff() > marker || this.config.inputPolicy === 'continue') {
        if (!this.setControllerState('running')) return;
        this.store.event('goal.resumed', { after_message: marker });
        return;
      }
      await sleep(300);
    }
  }
  writeResult(value) {
    const resultPath = path.join(this.directory, 'result.json');
    try { writeJSON(resultPath, value); }
    catch (error) {
      if (!fs.existsSync(resultPath)) throw error;
      try {
        fs.chmodSync(resultPath, 0o600);
        writeJSON(resultPath, value);
        this.store.event('report.result_permissions_repaired', { reason: error.message });
      } catch (retryError) {
        retryError.cause = error;
        throw retryError;
      }
    }
  }
  async finishCompletion(candidate, reportID, reason) {
    while (true) {
      if (this.store.finishCompletedRun(candidate, reportID)) return 'completed';
      if (this.controlLeaseLost()) return 'stopped';
      if (this.store.getMeta('control') === 'paused') {
        await sleep(200);
        continue;
      }
      this.store.reopenGoalOutcome(candidate, reportID, reason);
      return 'changed';
    }
  }
  async report(outcome) {
    if (outcome.kind !== 'achieved') throw new Error('최종 보고서는 목표 달성이 승인된 경우에만 생성할 수 있습니다.');
    const { assessment, candidate } = outcome;
    const goalOutcome = outcome.kind === 'achieved' ? 'achieved' : 'not_established';
    const terminationReason = outcome.kind === 'achieved' ? 'goal_achieved' : outcome.terminationReason;
    if (!candidate || !this.candidateIsCurrent(candidate)) return 'changed';
    this.store.setMeta('goal:pending_terminal', { kind: outcome.kind, assessment, candidate,
      ...(outcome.kind === 'achieved' ? {} : { terminationReason }) });
    const contract = this.store.getMeta('goal:contract');
    const view = this.goalContext();
    const { tasks, verified: facts, conflicted } = view;
    if (goalOutcome === 'achieved') {
      this.validateGoalAssessment(assessment, contract, view);
      this.validateGoalReview(assessment.independent_review, contract);
    }
    const editorConfiguration = { ...this.settings('editor'), timeout: this.config.timeout, permissions: this.config.permissions,
      codexBin: this.config.codexBin || null, claudeBin: this.config.claudeBin || null };
    const { control_epoch: _leaseEpoch, ...reportCandidate } = candidate;
    const reportID = hash(JSON.stringify({ candidate: reportCandidate, goalOutcome, terminationReason, assessment, editorConfiguration }));
    this.store.setMeta('report:status', { state: 'generating', id: reportID, contract_revision: contract.revision, assessment_round: assessment.round });
    const validateEditor = result => {
      if (new Set(result.fact_ids).size !== result.fact_ids.length || result.fact_ids.some(id => !facts.some(fact => fact.id === id))) throw new Error('최종 보고서에 중복 또는 검증되지 않은 사실 인용');
      if (result.fact_ids.some(id => !view.currentFactIDs.has(id))) throw new Error('최종 보고서에 현재 원본과 일치하지 않는 오래된 사실 인용');
    };
    let editor = null;
    let editorError = null;
    let controllerCheckpoint = false;
    const draft = this.store.getMeta('report:draft');
    if (draft?.id === reportID && draft.editor) {
      try {
        validateEditor(draft.editor);
        editor = draft.editor;
        editorError = draft.editor_error || null;
        this.store.event('report.draft_reused', { id: reportID });
      } catch (error) { this.store.event('report.draft_invalid', { id: reportID, reason: error.message }); }
    }
    if (!editor && terminationReason === 'segment_budget_exhausted') {
      controllerCheckpoint = true;
      editor = { title: 'ID2A 진행 체크포인트',
        body: '목표는 아직 달성되지 않았습니다. 저장된 작업·사실·증거에서 다음 실행 구간을 이어가세요.', fact_ids: [] };
      this.store.event('report.controller_checkpoint', { reason: terminationReason });
    }
    if (!editor) {
      try {
        const { result } = await this.runAgent('editor', null, {
          facts: view.compactFacts,
          context: { ...view.knowledge, coverage: view.coverage, task_counts: view.counts, goal_assessment: assessment,
            committed_outcome: goalOutcome, termination_reason: terminationReason,
            tasks: view.compactTasks, conflicts: conflicted.map(({ id, key, claim }) => ({ id, key, claim })) },
        });
        validateEditor(result);
        editor = result;
      } catch (error) {
        if (this.abortController.signal.aborted) throw error;
        editorError = error.message;
        this.store.event('report.editor_failed', { reason: error.message });
        editor = { title: 'ID2A 결과', body: '최종 편집 세션이 실패했습니다. 아래 원장과 작업 상태를 확인하세요.', fact_ids: [] };
      }
      this.store.setMeta('report:draft', { id: reportID, editor, ...(editorError ? { editor_error: editorError } : {}), created_at: now() });
    }
    if (!this.candidateIsCurrent(candidate)) {
      this.store.setMeta('report:status', { state: 'stale', id: reportID, contract_revision: contract.revision, assessment_round: assessment.round });
      this.store.setMeta('goal:pending_terminal', null);
      return 'changed';
    }
    const state = goalOutcome === 'achieved' ? 'completed' : 'suspended';
    const termination = { reason: terminationReason, at: now(), assessment_round: assessment.round, contract_revision: contract.revision };
    const generating = { state: 'generating', id: reportID, contract_revision: contract.revision,
      assessment_round: assessment.round,
      generation: controllerCheckpoint ? 'controller_checkpoint' : editorError ? 'controller_fallback' : 'editor',
      ...(editorError ? { editor_error: editorError } : {}) };
    const manifest = { format_version: 5, goal_format_version: this.store.getMeta('goal:format_version', 0),
      run: this.manifest.id, state, execution: { state }, goal_outcome: goalOutcome,
      termination, report: generating, contract, source: this.manifest.source, current_source: sourceIdentity(this.config.workspace),
      goal: assessment, tasks, facts, conflicts: conflicted, editor, ended: now() };
    const outcomeLabel = goalOutcome === 'achieved' ? '달성' : '미입증';
    const lines = [`# ${editor.title}`, '', `Run: ${this.manifest.id}`, `실행 상태: ${state}`, `목표 결과: ${outcomeLabel}`, `종료 이유: ${terminationReason}`,
      `자료 폴더: ${this.config.workspace}`, '', `목표 판정: ${assessment.reason}`, `진행 요약: ${assessment.progress}`, '', '## 필수 조건', '',
      ...assessment.requirement_evaluations.map(item => `- ${item.requirement_id} [${item.verdict}] ${item.reason}${item.fact_ids.length ? ` — ${item.fact_ids.map(id => `F${id}`).join(', ')}` : ''}`),
      '', editor.body, '', '## 작업', '',
      ...tasks.map(task => `- T${task.id} [${task.state}] ${task.title}${task.feedback ? ' — ' + task.feedback : ''}`), '', '## 검증된 사실과 증거', ''];
    for (const fact of facts) {
      lines.push(`- F${fact.id} [${fact.kind}] ${fact.key}: ${fact.claim}`);
      for (const evidence of fact.evidence) lines.push(`  - SHA-256 ${evidence.sha256}; 원본 ${evidence.source}; 보관 ${evidence.artifact}`);
    }
    if (conflicted.length) lines.push('', '## 해결되지 않은 충돌', '', ...conflicted.map(fact => `- F${fact.id} ${fact.key}: ${fact.claim}`));
    const reportPath = path.join(this.directory, 'report.md');
    const complete = { ...generating, state: 'complete', path: reportPath, completed_at: now() };
    let finalReport = complete;
    let writeError = null;
    try {
      fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
    } catch (error) {
      writeError = error;
      finalReport = { ...generating, state: 'failed', reason: error.message, failed_at: now() };
    }
    if (!this.store.commitGoalOutcome(candidate, { outcome: goalOutcome, termination, assessment, report: finalReport })) {
      if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
          || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return 'stopped';
      this.store.setMeta('report:status', { ...generating, state: 'stale', reason: 'context_changed' });
      this.store.setMeta('goal:pending_terminal', null);
      return 'changed';
    }
    if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
        || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return 'stopped';
    if (!this.candidateIsCurrent(candidate)) {
      this.store.reopenGoalOutcome(candidate, reportID, 'context_changed_after_commit');
      return 'changed';
    }
    if (writeError) {
      let resultError = null;
      try { this.writeResult({ ...manifest, report: finalReport }); }
      catch (error) { resultError = error.message; }
      this.store.event('report.write_failed', { reason: writeError.message, goal_outcome: goalOutcome,
        ...(resultError ? { result_error: resultError } : {}) });
    } else {
      try { this.writeResult({ ...manifest, report: complete }); }
      catch (error) {
        const failed = { ...generating, state: 'failed', reason: error.message, failed_at: now() };
        this.store.updateCommittedReport(candidate, reportID, failed);
        let resultError = null;
        try { this.writeResult({ ...manifest, report: failed }); }
        catch (retryError) { resultError = retryError.message; }
        this.store.event('report.write_failed', { reason: error.message, goal_outcome: goalOutcome,
          ...(resultError ? { result_error: resultError } : {}) });
      }
    }
    const finalized = await this.finishCompletion(candidate, reportID, 'context_changed_after_publish');
    if (finalized !== 'completed') return finalized;
    if (!writeError && this.store.getMeta('report:status')?.state === 'complete') {
      this.store.event(state === 'completed' ? 'run.finished' : 'run.suspended', {
        state, goal_outcome: goalOutcome, termination_reason: terminationReason,
        tasks: tasks.length, verified: facts.length, report: reportPath,
      });
    }
    return state;
  }
  async resumeTerminalReport(outcome, eventType) {
    this.store.event(eventType, { kind: outcome.kind, round: outcome.assessment.round });
    const ticker = setInterval(() => this.poll().catch(error => this.store.event('controller.warning', { reason: error.message })), 300);
    try { return await this.report(outcome); }
    catch (error) {
      if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
          || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) {
        this.abortController.abort();
        this.store.commitStopped('report', { fence: false });
        this.store.event('run.stopped', { resume: this.directory, stage: 'report' });
        return 'stopped';
      }
      this.store.setMeta('state', 'failed');
      this.store.setMeta('run:termination', { reason: 'controller_error', at: now(), detail: error.message });
      this.store.event('run.failed', { reason: error.message, stage: 'report' });
      throw error;
    } finally {
      clearInterval(ticker);
      while (this.polling) await sleep(10);
    }
  }
  async continueAcrossSegment(outcome, fallbackReason) {
    if (outcome?.kind === 'achieved') {
      const reported = await this.report(outcome);
      if (reported !== 'changed') return reported;
      this.beginSegment('context_changed');
      return null;
    }
    if (outcome?.kind === 'waiting') {
      await this.waitForInstruction(outcome.marker);
      if (this.abortController.signal.aborted) return null;
    }
    const reason = outcome?.terminationReason || (outcome?.kind === 'changed' ? 'context_changed' : fallbackReason);
    this.beginSegment(reason, outcome?.kind === 'changed' ? null : outcome);
    return null;
  }
  async run() {
    const source = sourceIdentity(this.config.workspace);
    const expected = this.store.getMeta('source:current', this.manifest.source);
    if (source.path !== expected.path) throw new Error('자료 폴더 경로가 바뀌었습니다. 올바른 workspace로 다시 실행하세요.');
    if (JSON.stringify(source) !== JSON.stringify(expected)) this.store.event('workspace.external_change', { expected, current: source });
    this.store.setMeta('source:current', source);
    const previousStatus = this.store.completionStatus();
    let expectedControl = this.initialControl;
    let expectedControlRevision = this.controlRevision;
    let claimedEpoch = null;
    while (claimedEpoch === null) {
      claimedEpoch = this.store.claimRunning(this.controlEpoch, expectedControl, expectedControlRevision);
      if (claimedEpoch !== null) break;
      const currentEpoch = this.store.getMeta('control:epoch', 0) || 0;
      const currentControl = this.store.getMeta('control');
      const currentControlRevision = this.store.getMeta('control:revision', 0) || 0;
      if (this.abortController.signal.aborted || currentEpoch !== this.controlEpoch) {
        this.abortController.abort();
        return 'stopped';
      }
      if (currentControl === 'paused') {
        await sleep(200);
        expectedControl = 'running';
        expectedControlRevision = currentControlRevision;
        continue;
      }
      expectedControl = currentControl;
      expectedControlRevision = currentControlRevision;
    }
    this.controlEpoch = claimedEpoch;
    this.store.transaction(() => {
      const pending = this.store.getMeta('goal:pending_terminal');
      if (pending?.candidate) this.store.setMeta('goal:pending_terminal', {
        ...pending, candidate: { ...pending.candidate, control_epoch: claimedEpoch },
      });
      const candidate = this.store.getMeta('goal:candidate');
      if (candidate) this.store.setMeta('goal:candidate', { ...candidate, control_epoch: claimedEpoch });
    });
    this.store.recover();
    const pendingTerminal = this.pendingTerminalOutcome();
    if (pendingTerminal && this.terminalLimitStillApplies(pendingTerminal)) {
      const resumed = await this.resumeTerminalReport(pendingTerminal, 'report.resume_pending');
      if (resumed !== 'changed') return resumed;
    } else if (pendingTerminal) {
      if (pendingTerminal.terminationReason === 'no_progress') this.noProgressResumeGrace = true;
      this.store.setMeta('goal:pending_terminal', null);
      this.store.event('goal.pending_terminal_discarded', { reason: 'explicit_resume', round: pendingTerminal.assessment.round });
    }
    const reusableTerminal = this.reusableTerminalOutcome(previousStatus);
    if (reusableTerminal && this.terminalLimitStillApplies(reusableTerminal)) {
      if (this.completedReportIsCurrent(previousStatus)) {
        const finalized = await this.finishCompletion(reusableTerminal.candidate, previousStatus.report.id, 'context_changed_during_resume');
        if (finalized === 'completed') {
          this.store.event('run.resume_noop', { goal_outcome: previousStatus.goal_outcome,
            termination_reason: previousStatus.termination?.reason });
          return 'completed';
        }
        if (finalized === 'stopped') return 'stopped';
      } else {
        const repaired = await this.resumeTerminalReport(reusableTerminal, 'report.retry');
        if (repaired !== 'changed') return repaired;
      }
    } else if (reusableTerminal) {
      this.store.event('run.resume_suspended', { termination_reason: reusableTerminal.terminationReason,
        previous_round: reusableTerminal.assessment.round });
    }
    if (['completed', 'suspended', 'stopped', 'failed'].includes(previousStatus.execution_state)) {
      const history = this.store.getMeta('run:history', []);
      history.push({ ...previousStatus, recorded_at: now(), assessment: this.store.getMeta('goal:assessment') });
      this.store.setMeta('run:history', history.slice(-100));
    }
    let prepared = false;
    while (!prepared) {
      this.store.transaction(() => {
        if (this.store.getMeta('control') !== 'running'
            || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) return;
        this.store.setMeta('state', 'running');
        this.store.setMeta('goal:outcome', 'pending');
        this.store.setMeta('run:termination', null);
        const previousReport = this.store.getMeta('report:status', { state: 'not_started' });
        if (['complete', 'failed', 'generating'].includes(previousReport.state)) this.store.setMeta('report:status', { ...previousReport, state: 'stale' });
        prepared = true;
      });
      if (prepared) break;
      if (this.controlLeaseLost()) {
        this.abortController.abort();
        return 'stopped';
      }
      await sleep(200);
    }
    this.beginSegment(previousStatus.execution_state === 'created' ? 'controller_started' : 'controller_resumed', null, 'run.started');
    const ticker = setInterval(() => this.poll().catch(error => this.store.event('controller.warning', { reason: error.message })), 300);
    try {
      while (!this.abortController.signal.aborted) {
        await this.poll();
        if (this.store.getMeta('control') === 'paused') { await sleep(200); continue; }
        if (!await this.honorStoredControlRetry('contract')) continue;
        this.assertControlBudget('contract');
        try {
          await this.ensureGoalContract();
          this.resetControlFailures('contract');
          break;
        }
        catch (error) {
          if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
              || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) throw error;
          if (error.code === 'ID2A_ATTEMPT_BUDGET') throw error;
          const contractFailures = this.recordControlFailure('contract', error);
          this.store.event('goal.contract_retry', { failures: contractFailures, reason: error.message });
          await this.waitForControlRetry('contract', contractFailures, error);
        }
      }
      this.setControllerState('running');
      while (!this.store.getMeta('planned') && !this.abortController.signal.aborted) {
        await this.poll();
        if (this.store.getMeta('control') === 'paused') { await sleep(200); continue; }
        if (this.attemptBudgetExhausted()) {
          const reported = await this.continueAcrossSegment(await this.segmentBudgetOutcome(), 'segment_budget_exhausted');
          if (reported) return reported;
          continue;
        }
        if (!await this.honorStoredControlRetry('plan')) continue;
        this.assertControlBudget('plan');
        try {
          await this.plan();
          this.resetControlFailures('plan');
        }
        catch (error) {
          if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
              || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) throw error;
          if (error.code === 'ID2A_ATTEMPT_BUDGET') {
            const reported = await this.continueAcrossSegment(await this.segmentBudgetOutcome(), 'segment_budget_exhausted');
            if (reported) return reported;
            continue;
          }
          const planFailures = this.recordControlFailure('plan', error);
          this.store.event('plan.retry', { failures: planFailures, reason: error.message });
          await this.waitForControlRetry('plan', planFailures, error);
        }
      }
      this.queueConflicts();
      while (!this.abortController.signal.aborted) {
        await this.poll();
        if (this.store.getMeta('control') === 'paused') { await sleep(200); continue; }
        if (!this.activeTasks.size && this.attemptBudgetExhausted()) {
          const reported = await this.continueAcrossSegment(await this.segmentBudgetOutcome(), 'segment_budget_exhausted');
          if (reported) return reported;
          continue;
        }
        if (!this.activeTasks.size) {
          const followupsReady = await this.recoverAcceptedFollowups();
          if (this.attemptBudgetExhausted()) {
            const reported = await this.continueAcrossSegment(await this.segmentBudgetOutcome(), 'segment_budget_exhausted');
            if (reported) return reported;
            continue;
          }
          if (!followupsReady || this.hasPendingFollowups()) continue;
        }
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
            // readyTasks() alone decides whether terminal dependencies make a
            // task impossible. Work added after the earlier ready snapshot must
            // remain queued for the next scheduler pass.
            await sleep(100);
            continue;
          }
          await this.curate(true);
          if (this.store.readyTasks().length || this.store.getMeta('control') !== 'running') continue;
          let outcome;
          try {
            if (!await this.honorStoredControlRetry('goal')) continue;
            this.assertControlBudget('goal');
            await this.ensureGoalContract();
            const pendingTasks = this.pendingTasks();
            const pendingFollowups = this.hasPendingFollowups();
            if (pendingTasks.length || pendingFollowups) {
              this.resetControlFailures('goal');
              this.store.event('goal.deferred_for_pending_work', {
                pending_tasks: pendingTasks.map(task => task.id),
                pending_followups: pendingFollowups,
              });
              continue;
            }
            outcome = this.goalRoundBudgetExhausted()
              ? this.goalRoundBudgetCheckpoint()
              : await this.assessGoal();
            this.resetControlFailures('goal');
          } catch (error) {
            if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
                || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) throw error;
            if (error.code === 'ID2A_ATTEMPT_BUDGET') {
              const reported = await this.continueAcrossSegment(await this.segmentBudgetOutcome(), 'segment_budget_exhausted');
              if (reported) return reported;
              continue;
            }
            const goalFailures = this.recordControlFailure('goal', error);
            this.store.setMeta('goal:feedback', error.message);
            this.store.event('goal.retry', { failures: goalFailures, reason: error.message });
            await this.waitForControlRetry('goal', goalFailures, error);
            continue;
          }
          if (outcome.kind === 'changed') continue;
          if ((outcome.kind === 'continue' || outcome.kind === 'retry') && this.attemptBudgetExhausted()) {
            const reported = await this.continueAcrossSegment(this.attemptBudgetCheckpoint(), 'segment_budget_exhausted');
            if (reported) return reported;
            continue;
          }
          if (outcome.kind === 'continue') continue;
          if (outcome.kind === 'retry') { await sleep(1000); continue; }
          if (outcome.kind === 'waiting') { await this.waitForInstruction(outcome.marker); continue; }
          if (outcome.kind === 'checkpoint') {
            const reported = await this.continueAcrossSegment(outcome, outcome.terminationReason);
            if (reported) return reported;
            continue;
          }
          const reported = await this.report(outcome);
          if (reported === 'changed') continue;
          return reported;
        }
        await sleep(100);
      }
      await Promise.allSettled(this.activeTasks.values());
      this.store.commitStopped(null, { fence: false });
      this.store.event('run.stopped', { resume: this.directory });
      return 'stopped';
    } catch (error) {
      if (this.abortController.signal.aborted || this.store.getMeta('control') === 'stopped'
          || (this.store.getMeta('control:epoch', 0) || 0) !== this.controlEpoch) {
        this.abortController.abort();
        await Promise.allSettled(this.activeTasks.values());
        this.store.commitStopped(null, { fence: false });
        this.store.event('run.stopped', { resume: this.directory });
        return 'stopped';
      }
      this.store.setMeta('state', 'failed');
      this.store.setMeta('run:termination', { reason: 'controller_error', at: now(), detail: error.message });
      this.setSegmentPhase('failed', { ended_at: now(), termination_reason: 'controller_error' });
      this.store.event('run.failed', { reason: error.message });
      throw error;
    } finally {
      clearInterval(ticker);
      while (this.polling) await sleep(10);
    }
  }
  close() { this.store.close(); this.releaseLock(); }
}
