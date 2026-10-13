import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VERSION, spawnCLI, stopChild } from './util.mjs';
import { parseResult, validate } from './schemas.mjs';

const mcpScript = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const textInput = text => [{ type: 'text', text }];
const toml = value => JSON.stringify(value); // Passed as an argv element, never shell text.

class JsonProcess {
  constructor(name, args, options, onMessage, onError) {
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.child = spawnCLI(name, args, options);
    this.child.on('error', onError);
    this.child.stdin.on('error', onError);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => {
      this.stderr = (this.stderr + text).slice(-12000);
      options.onEvent?.({ type: 'provider.stderr', text });
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { options.onEvent?.({ type: 'provider.stdout', text: line }); return; }
      options.onRaw?.(message);
      if ('id' in message && !message.method && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else {
        try { onMessage(message); } catch (error) { onError(error); }
      }
    });
    this.child.on('close', (code, signal) => {
      const error = new Error(`${name} 프로세스 종료 (${code ?? signal}). ${this.stderr.trim()}`);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      onError(error);
    });
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, milliseconds = 45000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: 응답 시간 초과`)); }, milliseconds);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('세션 종료')); }
    this.pending.clear();
    await stopChild(this.child);
    this.lines.close();
  }
}

export class CodexSession {
  constructor(options = {}) { this.options = options; this.done = false; }
  async open() {
    const args = ['app-server', '--listen', 'stdio://'];
    if (this.options.runDirectory) args.push(
      '-c', `mcp_servers.id2a_facts.command=${toml(process.execPath)}`,
      '-c', `mcp_servers.id2a_facts.args=${toml(['--disable-warning=ExperimentalWarning', mcpScript, '--run', this.options.runDirectory])}`,
      '-c', 'mcp_servers.id2a_facts.enabled=true',
    );
    this.protocol = new JsonProcess('codex', args, this.options, message => this.receive(message), error => this.fail(error));
    const initialized = await this.protocol.request('initialize', { clientInfo: { name: 'id2a', title: 'ID2A', version: VERSION } });
    this.protocol.send({ method: 'initialized', params: {} });
    return initialized;
  }
  receive(message) {
    if (message.method && 'id' in message) {
      // Unexpected permission/elicitation requests cannot silently escalate a role.
      if (message.method.endsWith('/requestApproval')) this.protocol.send({ id: message.id, result: { decision: 'decline' } });
      else this.protocol.send({ id: message.id, error: { code: -32601, message: 'ID2A unattended role cannot answer this request' } });
      this.options.onEvent?.({ type: 'provider.request_denied', method: message.method });
      return;
    }
    const { method, params = {} } = message;
    if (method === 'turn/started') {
      this.turnID = params.turn.id;
      this.options.onSession?.(this.threadID, this.turnID);
    }
    if (method === 'item/agentMessage/delta') {
      this.deltas.set(params.itemId, (this.deltas.get(params.itemId) || '') + params.delta);
      this.options.onEvent?.({ type: 'provider.delta', text: params.delta });
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      this.messages.push(params.item);
      this.options.onEvent?.({ type: 'provider.message', text: params.item.text, phase: params.item.phase });
    } else if (method === 'item/completed' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(params.item?.type)) {
      this.options.onEvent?.({ type: 'provider.item', item: params.item });
    }
    if (method === 'thread/tokenUsage/updated') this.options.onEvent?.({ type: 'provider.usage', usage: params.tokenUsage });
    if (method === 'warning' || method === 'configWarning' || method === 'error') this.options.onEvent?.({ type: 'provider.warning', detail: params });
    if (method === 'turn/completed') {
      if (params.turn.status !== 'completed') return this.fail(new Error(params.turn.error?.message || `Codex turn ${params.turn.status}`));
      const final = this.messages.filter(item => item.phase === 'final_answer').at(-1) || this.messages.at(-1);
      const text = final?.text || [...this.deltas.values()].at(-1) || '';
      try { this.finish(parseResult(text, this.schema)); } catch (error) { this.fail(new Error(`Codex 결과 JSON 오류: ${error.message}`)); }
    }
  }
  finish(value) { if (!this.done) { this.done = true; this.resolve?.(value); } }
  fail(error) { if (!this.done) { this.done = true; this.reject?.(error); this.startupError = error; } }
  async models() {
    try { await this.open(); return (await this.protocol.request('model/list', {})).data; }
    finally { this.done = true; await this.protocol?.close(); }
  }
  async run({ prompt, schema, sessionID, signal, readOnly = false, model, effort = 'auto', permissions = 'workspace' }) {
    this.schema = schema; this.deltas = new Map(); this.messages = [];
    const finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    finished.catch(() => {});
    const abort = () => this.fail(new Error('작업 중단 요청'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.fail(new Error('에이전트 실행 시간 초과')), (this.options.timeout || 1200) * 1000);
    try {
      if (signal?.aborted) throw new Error('작업 중단 요청');
      await this.open();
      if (this.startupError) throw this.startupError;
      const fullAccess = permissions === 'yolo';
      const params = {
        cwd: this.options.cwd, approvalPolicy: 'never',
        sandbox: fullAccess ? 'danger-full-access' : readOnly ? 'read-only' : 'workspace-write',
      };
      if (model) params.model = model;
      const thread = sessionID
        ? await this.protocol.request('thread/resume', { ...params, threadId: sessionID })
        : await this.protocol.request('thread/start', { ...params, ephemeral: readOnly });
      this.threadID = thread.thread.id;
      this.options.onSession?.(this.threadID);
      if (effort !== 'auto') {
        const catalog = (await this.protocol.request('model/list', { includeHidden: true })).data;
        const entry = catalog.find(item => item.model === (model || thread.model) || item.id === (model || thread.model));
        if (entry?.supportedReasoningEfforts?.length && !entry.supportedReasoningEfforts.some(item => (item.reasoningEffort || item.effort) === effort)) {
          throw new Error(`${entry.model || entry.id}: effort ${effort} 미지원`);
        }
      }
      const sandboxPolicy = fullAccess ? { type: 'dangerFullAccess' }
        : readOnly ? { type: 'readOnly' }
        : { type: 'workspaceWrite', writableRoots: [...new Set([this.options.cwd, this.options.taskDirectory].filter(Boolean))], networkAccess: false };
      const turn = { threadId: this.threadID, input: textInput(prompt), outputSchema: schema,
        approvalPolicy: 'never', sandboxPolicy };
      if (effort !== 'auto') turn.effort = effort;
      const started = await this.protocol.request('turn/start', turn);
      this.turnID = started.turn.id;
      this.options.onSession?.(this.threadID, this.turnID);
      return await finished;
    } finally {
      this.done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await this.protocol?.close();
    }
  }
  async steer(text) {
    if (this.done || !this.turnID || !this.threadID) return 'pending';
    await this.protocol.request('turn/steer', { threadId: this.threadID, expectedTurnId: this.turnID, input: textInput(text) });
    return 'accepted';
  }
}

export class ClaudeSession {
  constructor(options = {}) { this.options = options; this.done = false; this.sent = 0; this.received = 0; }
  async run({ prompt, schema, sessionID, signal, readOnly = false, model, effort = 'auto', permissions = 'workspace' }) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--json-schema', JSON.stringify(schema), '--permission-prompts', 'none'];
    const fullAccess = permissions === 'yolo';
    // In yolo mode Claude receives its native unrestricted flag for every role.
    // Read-only role behavior is then enforced by the role prompt and independent review contract.
    if (fullAccess) args.push('--dangerously-skip-permissions');
    else if (readOnly) args.push('--tools', 'Read,Grep,Glob');
    else args.push('--permission-mode', 'acceptEdits');
    const allowed = ['Read', 'Grep', 'Glob', ...(readOnly ? [] : ['Write', 'Edit', 'Bash'])];
    if (model) args.push('--model', model);
    if (effort !== 'auto') args.push('--effort', effort);
    if (sessionID) args.push('--resume', sessionID);
    if (this.options.workspace) args.push('--add-dir', this.options.workspace);
    if (this.options.runDirectory) {
      const config = path.join(this.options.taskDirectory || this.options.cwd, '.id2a-mcp.json');
      fs.writeFileSync(config, JSON.stringify({ mcpServers: { id2a_facts: {
        command: process.execPath, args: ['--disable-warning=ExperimentalWarning', mcpScript, '--run', this.options.runDirectory],
      } } }));
      args.push('--mcp-config', config);
      allowed.push('mcp__id2a_facts__ledger_page', 'mcp__id2a_facts__facts_search', 'mcp__id2a_facts__facts_get', 'mcp__id2a_facts__facts_context', 'mcp__id2a_facts__workspace_read', 'mcp__id2a_facts__evidence_read');
    }
    if (!fullAccess) args.push('--allowedTools', allowed.join(','));
    this.schema = schema;
    const finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    finished.catch(() => {});
    const abort = () => this.fail(new Error('작업 중단 요청'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.fail(new Error('에이전트 실행 시간 초과')), (this.options.timeout || 1200) * 1000);
    try {
      if (signal?.aborted) throw new Error('작업 중단 요청');
      this.protocol = new JsonProcess('claude', args, this.options, message => this.receive(message), error => this.fail(error));
      this.userMessage(prompt);
      return await finished;
    } finally {
      this.done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await this.protocol?.close();
    }
  }
  userMessage(text) {
    this.sent++;
    this.protocol.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.sessionID || '' });
  }
  receive(message) {
    if (message.session_id) { this.sessionID = message.session_id; this.options.onSession?.(this.sessionID); }
    if (message.type === 'stream_event' && message.event?.delta?.type === 'text_delta') this.options.onEvent?.({ type: 'provider.delta', text: message.event.delta.text });
    if (message.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if (block.type === 'text') this.options.onEvent?.({ type: 'provider.message', text: block.text });
        if (block.type === 'tool_use') this.options.onEvent?.({ type: 'provider.item', item: { type: 'tool_use', name: block.name, input: block.input } });
      }
    }
    if (message.type === 'control_request') {
      this.protocol.send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'No unattended permission escalation' } });
    }
    if (message.type === 'result') {
      this.received++;
      this.options.onEvent?.({ type: 'provider.usage', usage: message.usage, cost_usd: message.total_cost_usd });
      if (message.is_error || message.subtype !== 'success') return this.fail(new Error(`Claude: ${message.result || message.errors?.join('; ') || message.subtype}`));
      // Additional messages are processed in order. Never return the pre-instruction result.
      if (this.received < this.sent) return;
      try {
        const result = message.structured_output
          ? validate(message.structured_output, this.schema)
          : parseResult(message.result || '', this.schema);
        this.done = true; this.resolve(result);
      } catch (error) { this.fail(new Error(`Claude 결과 JSON 오류: ${error.message}`)); }
    }
  }
  fail(error) { if (!this.done) { this.done = true; this.reject?.(error); } }
  async steer(text) {
    if (this.done || !this.protocol) return 'pending';
    this.userMessage(text + '\nReturn a complete replacement result using the same JSON schema after incorporating this instruction.');
    return 'queued';
  }
}

export function providerFor(name, options) {
  if (name === 'codex') return new CodexSession(options);
  if (name === 'claude') return new ClaudeSession(options);
  throw new Error(`지원하지 않는 provider: ${name}`);
}
