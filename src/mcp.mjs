import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from './store.mjs';
import { VERSION, hash, integer, readJSON, within } from './util.mjs';

const runIndex = process.argv.indexOf('--run');
if (runIndex < 0 || !process.argv[runIndex + 1]) throw new Error('--run <run directory> 필요');
const store = new Store(path.resolve(process.argv[runIndex + 1]), { readOnly: true });
const workspace = fs.realpathSync(readJSON(path.join(store.directory, 'run.json')).source.path);
const tools = [
  { name: 'ledger_page', description: 'Enumerate facts, tasks, valid digests, or scope counts in stable order without a search query. Returns total/included/truncated, snapshot, as_of, and next_offset. Continue with the same collection, filters, snapshot and next_offset until null. A changed ledger requires restarting at offset 0 without snapshot. Facts include full claims; use facts_get for evidence. Scope counts are exact-scope counts; filtering includes child scopes.',
    inputSchema: { type: 'object', properties: { collection: { type: 'string', enum: ['facts', 'tasks', 'digests', 'scopes'] },
      scope: { type: 'string' }, state: { type: 'string' }, snapshot: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['collection'], additionalProperties: false } },
  { name: 'facts_search', description: 'Search run-local facts. Each result explicitly identifies verification state and evidence hashes.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false } },
  { name: 'facts_get', description: 'Get one fact, its current state, provenance, and immutable evidence file paths.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, snapshot: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'facts_context', description: 'Get a bounded pack of verified facts, visibly marked conflicts, and valid digests for a task.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'integer', minimum: 1 } }, required: ['task_id'], additionalProperties: false } },
  { name: 'workspace_read', description: 'Read a bounded text excerpt of a source file within the declared project. Includes absolute path, line numbers, and full-file SHA-256. No command execution.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, max_lines: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['path'], additionalProperties: false } },
  { name: 'evidence_read', description: 'Read a bounded text excerpt from an immutable evidence snapshot registered to a fact. The fact ID and SHA-256 must match the ledger.',
    inputSchema: { type: 'object', properties: { fact_id: { type: 'integer', minimum: 1 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, start_line: { type: 'integer', minimum: 1 }, max_lines: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['fact_id', 'sha256'], additionalProperties: false } },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
function textExcerpt(source, args, maximumBytes, metadata = {}) {
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size > maximumBytes) throw new Error(`${Math.floor(maximumBytes / 1024 / 1024)}MB 이하의 일반 텍스트 파일만 읽을 수 있습니다.`);
  const bytes = fs.readFileSync(source);
  if (bytes.includes(0)) throw new Error('바이너리 파일은 읽을 수 없습니다.');
  const lines = bytes.toString('utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const start = integer(args.start_line ?? 1, 'start_line', 1, Number.MAX_SAFE_INTEGER);
  const count = integer(args.max_lines ?? 200, 'max_lines', 1, 1000);
  const excerpt = lines.slice(start - 1, start - 1 + count);
  const numbered = excerpt.map((line, index) => `${start + index}: ${line}`).join('\n');
  return { ...metadata, path: source, sha256: hash(bytes), start_line: start, total_lines: lines.length,
    truncated: numbered.length > 50000 || start - 1 + count < lines.length, text: numbered.slice(0, 50000) };
}
function call(name, args) {
  if (name === 'ledger_page') return store.ledgerPage(args);
  if (name === 'facts_search') {
    if (typeof args.query !== 'string') throw new Error('query 필요');
    return store.search(args.query, { scope: args.scope, limit: integer(args.limit ?? 12, 'limit', 1, 30) });
  }
  if (name === 'facts_get') {
    const view = store.ledgerView();
    if (args.snapshot !== undefined && args.snapshot !== view.snapshot) throw new Error('원장이 변경되었습니다. ledger_page에서 새 snapshot을 조회하세요.');
    const id = integer(args.id, 'id', 1, Number.MAX_SAFE_INTEGER);
    const fact = view.facts.find(item => item.id === id);
    if (!fact) throw new Error(`사실 F${id} 없음`);
    return { ...fact, snapshot: view.snapshot, as_of: view.as_of };
  }
  if (name === 'facts_context') return store.context(store.task(integer(args.task_id, 'task_id')));
  if (name === 'evidence_read') {
    const fact = store.fact(integer(args.fact_id, 'fact_id', 1, Number.MAX_SAFE_INTEGER));
    if (typeof args.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(args.sha256)) throw new Error('유효한 sha256 필요');
    const evidence = fact.evidence.find(item => item.sha256 === args.sha256);
    if (!evidence) throw new Error(`F${fact.id}에 등록되지 않은 증거입니다.`);
    const result = textExcerpt(evidence.artifact, args, 64 * 1024 * 1024, { fact_id: fact.id, source: evidence.source, note: evidence.note });
    if (result.sha256 !== evidence.sha256) throw new Error(`F${fact.id}: 증거 해시 불일치`);
    return result;
  }
  if (name === 'workspace_read') {
    if (typeof args.path !== 'string') throw new Error('path 필요');
    const candidate = path.resolve(workspace, args.path);
    if (!within(workspace, candidate)) throw new Error('자료 폴더 밖의 파일을 읽을 수 없습니다.');
    const source = fs.realpathSync(candidate);
    if (!within(workspace, source)) throw new Error('자료 폴더 밖의 파일을 읽을 수 없습니다.');
    return textExcerpt(source, args, 8 * 1024 * 1024);
  }
  throw new Error(`알 수 없는 read-only tool: ${name}`);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!('id' in message)) return;
  let result;
  try {
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'id2a-facts', version: VERSION } };
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/call') {
      try { result = { content: [{ type: 'text', text: JSON.stringify(call(message.params.name, message.params.arguments || {})) }] }; }
      catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
    } else throw new Error(`지원하지 않는 method: ${message.method}`);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: error.message } }) + '\n');
  }
});
lines.on('close', () => store.close());
