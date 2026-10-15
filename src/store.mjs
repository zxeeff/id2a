import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boundedJSON, hash, integer, normalize, now, readText, within } from './util.mjs';
import { goalAnchor, schemas, validate } from './schemas.mjs';
import { graphProblems, validateTaskClaims } from './frontier.mjs';

export class Store {
  constructor(directory, { readOnly = false, onEvent } = {}) {
    this.directory = path.resolve(directory);
    this.onEvent = onEvent;
    this.db = new DatabaseSync(path.join(this.directory, 'ledger.sqlite'), { readOnly });
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    if (readOnly) return;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL, scope TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'work', state TEXT NOT NULL DEFAULT 'queued',
        signature TEXT UNIQUE NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]',
        revisions INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        result TEXT, feedback TEXT NOT NULL DEFAULT '', created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY, key TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
        claim TEXT NOT NULL, claim_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'proposed',
        reason TEXT NOT NULL DEFAULT '', created TEXT NOT NULL,
        UNIQUE(key, claim_hash, kind)
      );
      CREATE TABLE IF NOT EXISTS origins (
        fact_id INTEGER NOT NULL REFERENCES facts(id), task_id INTEGER NOT NULL REFERENCES tasks(id),
        PRIMARY KEY(fact_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY, fact_id INTEGER NOT NULL REFERENCES facts(id),
        task_id INTEGER NOT NULL REFERENCES tasks(id), submission INTEGER NOT NULL DEFAULT 1, sha256 TEXT NOT NULL,
        source TEXT NOT NULL, note TEXT NOT NULL, bytes INTEGER NOT NULL,
        UNIQUE(fact_id, task_id, submission, source, sha256, note)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), role TEXT NOT NULL,
        provider TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running',
        session_id TEXT, turn_id TEXT, created TEXT NOT NULL, ended TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, target TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id INTEGER NOT NULL REFERENCES messages(id), attempt_id INTEGER NOT NULL REFERENCES attempts(id),
        state TEXT NOT NULL, PRIMARY KEY(message_id, attempt_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, time TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, summary TEXT NOT NULL, fact_ids TEXT NOT NULL, created TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fact_search USING fts5(key, scope, claim, content='facts', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS facts_insert AFTER INSERT ON facts BEGIN
        INSERT INTO fact_search(rowid, key, scope, claim) VALUES(new.id, new.key, new.scope, new.claim);
      END;
    `);
    const taskColumns = this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
    if (!taskColumns.includes('resources')) this.db.exec("ALTER TABLE tasks ADD COLUMN resources TEXT NOT NULL DEFAULT '{\"workspace\":\"write\",\"cpu\":1}'");
    if (!taskColumns.includes('logical_key')) this.db.exec('ALTER TABLE tasks ADD COLUMN logical_key TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_logical_key ON tasks(logical_key) WHERE logical_key IS NOT NULL');
    const evidenceColumns = this.db.prepare('PRAGMA table_info(evidence)').all();
    const hasSubmission = evidenceColumns.some(column => column.name === 'submission');
    const expectedUnique = ['fact_id', 'task_id', 'submission', 'source', 'sha256', 'note'];
    const hasSubmissionUnique = this.db.prepare('PRAGMA index_list(evidence)').all()
      .filter(index => index.unique)
      .some(index => {
        const name = index.name.replaceAll("'", "''");
        const columns = this.db.prepare(`PRAGMA index_info('${name}')`).all().map(column => column.name);
        return JSON.stringify(columns) === JSON.stringify(expectedUnique);
      });
    if (!hasSubmission || !hasSubmissionUnique) {
      const submission = hasSubmission ? 'submission' : '1';
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE evidence RENAME TO evidence_migration;
        CREATE TABLE evidence (
          id INTEGER PRIMARY KEY, fact_id INTEGER NOT NULL REFERENCES facts(id),
          task_id INTEGER NOT NULL REFERENCES tasks(id), submission INTEGER NOT NULL DEFAULT 1, sha256 TEXT NOT NULL,
          source TEXT NOT NULL, note TEXT NOT NULL, bytes INTEGER NOT NULL,
          UNIQUE(fact_id, task_id, submission, source, sha256, note)
        );
        INSERT INTO evidence(id,fact_id,task_id,submission,sha256,source,note,bytes)
          SELECT id,fact_id,task_id,${submission},sha256,source,note,bytes FROM evidence_migration;
        DROP TABLE evidence_migration;
        COMMIT;
      `);
    }
    if (this.getMeta('state') === 'completed' && this.getMeta('goal:outcome') === 'not_established') {
      this.setMeta('state', 'suspended');
      if (this.getMeta('control') === 'running') this.setMeta('control', 'paused');
    }
    fs.mkdirSync(path.join(this.directory, 'artifacts'), { recursive: true });
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  requestControl(control) {
    if (!['running', 'paused'].includes(control)) throw new Error(`잘못된 제어 요청: ${control}`);
    return this.transaction(() => {
      const revision = (this.getMeta('control:revision', 0) || 0) + 1;
      this.setMeta('control', control);
      this.setMeta('control:revision', revision);
      return revision;
    });
  }
  goalSource() {
    const goal = readText(path.join(this.directory, 'prompt.txt'));
    const instructions = this.db.prepare("SELECT id,text FROM messages WHERE target='all' ORDER BY id").all()
      .map(message => ({ id: message.id, text: message.text, sha256: hash(message.text) }));
    const messageCutoff = instructions.at(-1)?.id || 0;
    const identity = { goal_sha256: hash(goal), instructions: instructions.map(({ id, sha256 }) => ({ id, sha256 })), message_cutoff: messageCutoff };
    return { ...identity, fingerprint: hash(JSON.stringify(identity)), effective_text: [goal, ...instructions.map(item => item.text)].join('\n') };
  }
  completionStatus() {
    const state = this.getMeta('state');
    const explicitOutcome = this.getMeta('goal:outcome');
    const termination = this.getMeta('run:termination');
    const report = this.getMeta('report:status');
    // Version 3 wrote resumable non-achievement checkpoints as completed. Keep
    // the ledger intact while presenting those records with the current state model.
    const executionState = state === 'completed' && explicitOutcome === 'not_established' ? 'suspended' : state;
    return {
      format_version: 5,
      goal_format_version: this.getMeta('goal:format_version', 0),
      execution_state: executionState,
      goal_outcome: explicitOutcome || (state === 'completed' ? 'legacy_unknown' : 'pending'),
      termination: termination || (state === 'completed' ? { reason: 'legacy_unknown' } : null),
      report: report || (fs.existsSync(path.join(this.directory, 'report.md')) ? { state: 'legacy_unknown' } : { state: 'not_started' }),
    };
  }
  event(type, data = {}) {
    const time = now();
    const id = Number(this.db.prepare('INSERT INTO events(time,type,data) VALUES (?,?,?)').run(time, type, JSON.stringify(data)).lastInsertRowid);
    const event = { id, time, type, ...data };
    fs.appendFileSync(path.join(this.directory, 'events.jsonl'), JSON.stringify(event) + '\n');
    this.onEvent?.(event);
    return event;
  }
  events(after = 0, limit = 100) {
    return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, limit)
      .map(row => ({ id: row.id, time: row.time, type: row.type, ...JSON.parse(row.data) }));
  }
  reopenCompletedForWork(reason) {
    if (this.getMeta('state') !== 'completed' || this.getMeta('goal:outcome') !== 'achieved') return false;
    const control = this.getMeta('control');
    const epoch = this.getMeta('control:epoch', 0) || 0;
    const active = ['running', 'paused'].includes(control) && this.getMeta('control:lease') === epoch;
    const changedAt = now();
    if (!active) this.setMeta('control', 'stopped');
    this.setMeta('state', active ? 'running' : 'stopped');
    this.setMeta('goal:outcome', 'pending');
    this.setMeta('run:termination', active ? null : { reason, at: changedAt });
    this.setMeta('goal:candidate', null);
    this.setMeta('goal:pending_terminal', null);
    const report = this.getMeta('report:status', { state: 'not_started' });
    if (report.state !== 'not_started') this.setMeta('report:status', { ...report, state: 'stale', reason });
    const segment = this.getMeta('run:segment_state');
    if (segment) this.setMeta('run:segment_state', { ...segment,
      phase: active ? 'running' : 'stopped', ended_at: active ? null : changedAt,
      termination_reason: active ? null : reason });
    return true;
  }
  addTask(task, { dependencies = [], kind = 'work', signature } = {}) {
    validate(task, schemas.worker.properties.followups.items);
    const fingerprint = signature || hash(normalize(`${task.title}\n${task.brief}\n${task.scope}`).toLowerCase());
    const resources = validateTaskClaims(task);
    const id = this.transaction(() => {
      if (task.logical_key && this.getMeta('task:key:' + task.logical_key)) return null;
      if (dependencies.some(id => !Number.isSafeInteger(id) || !this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id))) throw new Error('Unknown task dependency.');
      const result = this.db.prepare('INSERT OR IGNORE INTO tasks(title,brief,scope,kind,signature,dependencies,resources,logical_key,created) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(task.title, task.brief, task.scope, kind, fingerprint, JSON.stringify([...new Set(dependencies)]), JSON.stringify(resources), task.logical_key || null, now());
      if (!result.changes) return null;
      if (task.logical_key) this.aliasTask(task.logical_key, Number(result.lastInsertRowid));
      this.reopenCompletedForWork('task_added_after_completion');
      return Number(result.lastInsertRowid);
    });
    if (id === null) return null;
    this.event('task.queued', { task: id, title: task.title, kind });
    return id;
  }
  existingTask(task) {
    if (task.logical_key) {
      const alias = this.getMeta('task:key:' + task.logical_key);
      if (alias) return alias;
      const same = this.db.prepare('SELECT id FROM tasks WHERE logical_key=?').get(task.logical_key);
      if (same) return same.id;
    }
    const signature = hash(normalize(`${task.title}\n${task.brief}\n${task.scope}`).toLowerCase());
    return this.db.prepare('SELECT id FROM tasks WHERE signature=?').get(signature)?.id;
  }
  aliasTask(key, id) {
    if (!Number.isSafeInteger(id) || !this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id)) throw new Error('Unknown task for logical key.');
    const previous = this.getMeta('task:key:' + key);
    if (previous && previous !== id) throw new Error('Task logical key already identifies different work.');
    this.setMeta('task:key:' + key, id);
  }
  taskWithSignature(signature) {
    return this.db.prepare('SELECT id FROM tasks WHERE signature=?').get(signature)?.id;
  }
  followupGeneration(task, contract = this.getMeta('goal:contract'), source = this.goalSource()) {
    return hash(JSON.stringify({
      worker_generation: this.getMeta('worker:generation:' + task.id, 0) || 0,
      followups: task.result?.followups || [],
      goal_source: source.fingerprint,
      contract: contract ? { revision: contract.revision, fingerprint: hash(JSON.stringify(contract)) } : null,
    }));
  }
  followupsComplete(task, generation = this.followupGeneration(task)) {
    return this.getMeta('followups:' + task.id) === true
      && this.getMeta('followups:generation:' + task.id) === generation;
  }
  task(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error(`작업 T${id} 없음`);
    // A newly spawned read-only MCP may serve an old running controller. Do
    // not add fields to its legacy ledger fingerprint before schema migration.
    return { ...row, ...(Object.hasOwn(row, 'resources') ? {
      resources: JSON.parse(row.resources), logical_key: row.logical_key || null,
    } : {}), dependencies: JSON.parse(row.dependencies), result: row.result ? JSON.parse(row.result) : null };
  }
  tasks() { return this.db.prepare('SELECT id FROM tasks ORDER BY id').all().map(row => this.task(row.id)); }
  updateTask(id, patch, { expectedState = null, expectedControlEpoch = null, allowStopped = false } = {}) {
    const allowed = new Set(['state', 'revisions', 'failures', 'result', 'feedback']);
    const entries = Object.entries(patch);
    if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error('잘못된 task patch');
    const updated = this.transaction(() => {
      if (expectedState && this.task(id).state !== expectedState) return false;
      if (expectedControlEpoch !== null) {
        const control = this.getMeta('control');
        const epoch = this.getMeta('control:epoch', 0) || 0;
        const sameLease = epoch === expectedControlEpoch
          && this.getMeta('control:lease') === expectedControlEpoch
          && ['running', 'paused'].includes(control);
        if (!sameLease && !(allowStopped && control === 'stopped')) return false;
      }
      const result = this.db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
        .run(...entries.map(([key, value]) => key === 'result' && value !== null ? JSON.stringify(value) : value), id);
      if (!result.changes) return false;
      if (['queued', 'reviewing', 'running'].includes(patch.state)) this.reopenCompletedForWork('task_reopened_after_completion');
      return true;
    });
    if (updated && patch.state) this.event('task.state', { task: id, state: patch.state, reason: patch.feedback || '' });
    return updated;
  }
  readyTasks() {
    const tasks = this.tasks();
    const byID = new Map(tasks.map(task => [task.id, task]));
    const invalid = graphProblems(tasks);
    const ready = [];
    for (const task of tasks.filter(task => task.state === 'queued' || task.state === 'reviewing')) {
      if (invalid.has(task.id)) {
        this.updateTask(task.id, { state: 'blocked', feedback: 'Missing dependency or dependency cycle; Goal must resolve this work.' });
        task.state = 'blocked';
      } else if (task.dependencies.some(id => ['rejected', 'stalled', 'blocked', 'cancelled'].includes(byID.get(id).state))) {
        this.updateTask(task.id, { state: 'blocked', feedback: '선행 작업이 승인되지 않았습니다.' });
        task.state = 'blocked';
      } else if (task.dependencies.every(id => byID.get(id).state === 'accepted')) ready.push(task);
    }
    return ready;
  }
  evidenceFile(digest) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('잘못된 증거 해시');
    return path.join(this.directory, 'artifacts', digest + '.blob');
  }
  ingestEvidence(reference, taskDirectory, workspace) {
    if (!within(fs.realpathSync(this.directory), fs.realpathSync(taskDirectory))) throw new Error('작업 폴더가 run 밖으로 이동했습니다.');
    const candidate = path.isAbsolute(reference.path) ? reference.path : path.resolve(taskDirectory, reference.path);
    const roots = [fs.realpathSync(taskDirectory), fs.realpathSync(workspace)];
    if (!roots.some(root => within(root, path.resolve(candidate)))) throw new Error(`허용한 작업/자료 폴더 밖의 증거: ${reference.path}`);
    const source = fs.realpathSync(candidate);
    if (!roots.some(root => within(root, source))) throw new Error(`허용한 작업/자료 폴더 밖의 증거: ${reference.path}`);
    const before = fs.statSync(source);
    if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error('증거는 64MB 이하의 일반 파일이어야 합니다.');
    const bytes = fs.readFileSync(source);
    const after = fs.statSync(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('읽는 중 증거가 변경됐습니다.');
    const sha256 = hash(bytes);
    const destination = this.evidenceFile(sha256);
    if (!fs.existsSync(destination)) fs.writeFileSync(destination, bytes, { flag: 'wx' });
    else if (hash(fs.readFileSync(destination)) !== sha256) throw new Error('저장된 증거가 변조됐습니다.');
    return { sha256, source, note: reference.note, bytes: bytes.length };
  }
  writeDerivedArtifacts(artifacts, taskDirectory) {
    if (artifacts.length > 16) throw new Error('파생 파일은 작업당 16개 이하로 제출하세요.');
    if (!within(fs.realpathSync(this.directory), fs.realpathSync(taskDirectory))) throw new Error('작업 폴더가 run 밖으로 이동했습니다.');
    const root = path.join(taskDirectory, 'outputs');
    fs.mkdirSync(root, { recursive: true });
    const canonicalRoot = fs.realpathSync(root);
    if (!within(fs.realpathSync(taskDirectory), canonicalRoot)) throw new Error('출력 디렉터리의 링크가 작업 폴더 밖으로 향합니다.');
    const seen = new Set();
    let totalBytes = 0;
    const prepared = artifacts.map(artifact => {
      const name = artifact.path.replace(/\\/gu, '/');
      const segments = name.split('/');
      if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/u.test(segment) || /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) throw new Error(`잘못된 출력 경로: ${name}`);
      const identity = name.normalize('NFKC').toLowerCase();
      if (seen.has(identity)) throw new Error('중복 파생 파일 경로');
      seen.add(identity);
      const bytes = Buffer.byteLength(artifact.content, 'utf8'); totalBytes += bytes;
      if (bytes > 512 * 1024 || totalBytes > 2 * 1024 * 1024) throw new Error('파생 파일 상한: 파일당 512KB, 합계 2MB');
      return { ...artifact, name, segments };
    });
    for (const artifact of prepared) {
      let parent = canonicalRoot;
      for (const segment of artifact.segments.slice(0, -1)) {
        parent = path.join(parent, segment);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent);
        if (!fs.statSync(parent).isDirectory() || !within(canonicalRoot, fs.realpathSync(parent))) throw new Error('출력 경로의 링크 또는 부모 디렉터리 오류');
      }
      const destination = path.join(parent, artifact.segments.at(-1));
      if (!within(canonicalRoot, destination)) throw new Error('출력 경로 이탈');
      if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.statSync(destination).isFile())) throw new Error('링크 또는 일반 파일이 아닌 출력 대상을 덮어쓸 수 없습니다.');
      fs.writeFileSync(destination, artifact.content, 'utf8');
    }
  }
  submitWorker(taskID, result, taskDirectory, workspace, { expectedState = null } = {}) {
    validate(result, schemas.worker);
    if (result.facts.length > 40 || result.followups.length > 8) throw new Error('한 작업의 사실/후속 작업 상한 초과');
    for (const followup of result.followups) validateTaskClaims(followup);
    // A revised worker submission has its own followup set. Clear the prior
    // completion marker before persisting it so a crash can only cause a safe retry.
    this.setMeta('followups:' + taskID, null);
    this.setMeta('followups:generation:' + taskID, null);
    this.setMeta('worker:generation:' + taskID, (this.getMeta('worker:generation:' + taskID, 0) || 0) + 1);
    this.writeDerivedArtifacts(result.artifacts, taskDirectory);
    const prepared = result.facts.map(fact => {
      const key = normalize(fact.key).toLowerCase();
      if (!/^[\p{L}\p{N}_.:-]{1,180}$/u.test(key) || !fact.claim.trim() || !fact.scope.trim()) throw new Error('사실 key/claim/scope 형식 오류');
      if (fact.claim.length > 3000 || fact.scope.length > 180 || fact.evidence.length > 8 || fact.evidence.some(item => item.note.length > 2000)) throw new Error('사실 또는 증거 메타데이터 상한 초과');
      if (!fact.evidence.length) throw new Error(`${key}: 증거 파일이 필요합니다.`);
      return { ...fact, key, claim: normalize(fact.claim), evidence: fact.evidence.map(reference => this.ingestEvidence(reference, taskDirectory, workspace)) };
    });
    const ids = this.transaction(() => {
      if (expectedState && this.task(taskID).state !== expectedState) return null;
      const submission = Number(this.db.prepare('SELECT COALESCE(MAX(submission),0)+1 AS id FROM evidence WHERE task_id=?').get(taskID).id);
      const committedIDs = prepared.map(fact => {
        const claimHash = hash(fact.claim);
        this.db.prepare('INSERT OR IGNORE INTO facts(key,scope,kind,claim,claim_hash,created) VALUES (?,?,?,?,?,?)')
          .run(fact.key, fact.scope, fact.kind, fact.claim, claimHash, now());
        const row = this.db.prepare('SELECT id FROM facts WHERE key=? AND claim_hash=? AND kind=?').get(fact.key, claimHash, fact.kind);
        this.db.prepare('INSERT OR IGNORE INTO origins VALUES (?,?)').run(row.id, taskID);
        for (const evidence of fact.evidence) this.db.prepare(
          'INSERT OR IGNORE INTO evidence(fact_id,task_id,submission,sha256,source,note,bytes) VALUES (?,?,?,?,?,?,?)'
        ).run(row.id, taskID, submission, evidence.sha256, evidence.source, evidence.note, evidence.bytes);
        return row.id;
      });
      this.db.prepare("UPDATE tasks SET result=?,state='reviewing' WHERE id=?")
        .run(JSON.stringify({ ...result, fact_ids: [...new Set(committedIDs)] }), taskID);
      return committedIDs;
    });
    if (ids === null) {
      this.event('task.submission_discarded', { task: taskID, reason: 'task_changed_during_worker' });
      return null;
    }
    this.event('task.state', { task: taskID, state: 'reviewing', reason: '' });
    this.event('facts.proposed', { task: taskID, facts: [...new Set(ids)] });
    return [...new Set(ids)];
  }
  fact(id) {
    const row = this.db.prepare('SELECT * FROM facts WHERE id=?').get(id);
    if (!row) throw new Error(`사실 F${id} 없음`);
    const evidence = this.db.prepare('SELECT * FROM evidence WHERE fact_id=? ORDER BY id').all(id)
      .map(item => ({ ...item, artifact: this.evidenceFile(item.sha256) }));
    const origins = this.db.prepare('SELECT task_id FROM origins WHERE fact_id=? ORDER BY task_id').all(id).map(item => item.task_id);
    return { ...row, evidence, origins };
  }
  factsForTask(id) {
    return this.db.prepare('SELECT fact_id FROM origins WHERE task_id=? ORDER BY fact_id').all(id).map(row => this.fact(row.fact_id));
  }
  listFacts({ state, scope, limit = 100 } = {}) {
    const conditions = [], values = [];
    if (state) { conditions.push('state=?'); values.push(state); }
    if (scope) { conditions.push('(scope=? OR scope LIKE ? ESCAPE \'\\\')'); values.push(scope, scope.replace(/[\\%_]/gu, '\\$&') + '.%'); }
    values.push(Math.max(1, Math.min(500, limit)));
    return this.db.prepare(`SELECT id FROM facts ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...values).map(row => this.fact(row.id));
  }
  allFacts(state) {
    const rows = state ? this.db.prepare('SELECT id FROM facts WHERE state=? ORDER BY id').all(state)
      : this.db.prepare('SELECT id FROM facts ORDER BY id').all();
    return rows.map(row => this.fact(row.id));
  }
  ledgerData() {
    const facts = this.allFacts(), tasks = this.tasks();
    const digests = this.db.prepare('SELECT * FROM digests ORDER BY id').all()
      .map(row => ({ ...row, fact_ids: JSON.parse(row.fact_ids) }));
    return { facts, tasks, digests, snapshot: hash(JSON.stringify({ facts, tasks, digests })), as_of: now() };
  }
  ledgerView() {
    // Read every collection from one SQLite snapshot. The content fingerprint also
    // works across independent read-only MCP connections and existing run ledgers.
    this.db.exec('BEGIN');
    try { return this.ledgerData(); }
    finally { this.db.exec('COMMIT'); }
  }
  evidenceStatus(view = this.ledgerView()) {
    const fileStates = new Map();
    const inspect = file => {
      if (fileStates.has(file)) return fileStates.get(file);
      let state;
      try {
        const stat = fs.statSync(file);
        state = stat.isFile() ? { exists: true, bytes: stat.size, sha256: hash(fs.readFileSync(file)) } : { exists: false, bytes: 0, sha256: null };
      } catch { state = { exists: false, bytes: 0, sha256: null }; }
      fileStates.set(file, state);
      return state;
    };
    const facts = {};
    for (const fact of view.facts.filter(item => item.state === 'verified')) {
      // Evidence submitted by one task is conjunctive; a later independent task
      // may provide an alternative complete evidence set for the same claim.
      const checks = fact.evidence.map(evidence => ({ submission: `${evidence.task_id}:${evidence.submission || 1}`,
        current: inspect(evidence.source).sha256 === evidence.sha256 }));
      const bySubmission = Map.groupBy(checks, item => item.submission);
      facts[fact.id] = [...bySubmission.values()].some(group => group.length > 0 && group.every(item => item.current));
    }
    const artifacts = view.tasks.flatMap(task => (this.taskRecord(task).result?.artifacts || []).map(artifact => ({ task: task.id, ...artifact })));
    const sources = [...fileStates].map(([file, state]) => ({ file, ...state })).sort((left, right) => left.file.localeCompare(right.file));
    return { facts, snapshot: hash(JSON.stringify({ sources, artifacts })), sources, artifacts };
  }
  commitStopped(detail = null, { fence = true } = {}) {
    let committed = false;
    this.transaction(() => {
      const state = this.getMeta('state');
      const outcome = this.getMeta('goal:outcome');
      const control = this.getMeta('control');
      // A stop command is also a fence. Even if the persisted state is already
      // stopped, a controller may have captured that state and be about to claim
      // it for resume. Advancing the epoch makes that pending claim fail.
      if (control !== 'stopped' || fence) {
        this.setMeta('control:epoch', (this.getMeta('control:epoch', 0) || 0) + 1);
        this.setMeta('control', 'stopped');
        committed = true;
      }
      if (this.getMeta('control:lease') !== null) {
        this.setMeta('control:lease', null);
        committed = true;
      }
      if (state === 'completed' && outcome === 'achieved') {
        const report = this.getMeta('report:status', { state: 'not_started' });
        if (report.state === 'generating') this.setMeta('report:status', { ...report, state: 'stale', reason: 'user_stopped' });
        if (report.state === 'generating') committed = true;
        return;
      }
      if (control === 'stopped' && state === 'stopped') {
        if (fence) {
          const previous = this.getMeta('run:termination');
          const stoppedAt = previous?.reason === 'user_stopped' ? previous.at : now();
          this.setMeta('run:termination', { reason: 'user_stopped', at: stoppedAt, ...(detail ? { detail } : {}) });
          const segment = this.getMeta('run:segment_state');
          if (segment) this.setMeta('run:segment_state', { ...segment, phase: 'stopped', ended_at: stoppedAt,
            termination_reason: 'user_stopped' });
          committed = true;
        }
        const report = this.getMeta('report:status', { state: 'not_started' });
        if (report.state === 'generating') {
          this.setMeta('report:status', { ...report, state: 'stale', reason: 'user_stopped' });
          committed = true;
        }
        return;
      }
      const previous = this.getMeta('run:termination');
      const stoppedAt = previous?.reason === 'user_stopped' ? previous.at : now();
      this.setMeta('state', 'stopped');
      this.setMeta('run:termination', { reason: 'user_stopped', at: stoppedAt, ...(detail ? { detail } : {}) });
      const segment = this.getMeta('run:segment_state');
      if (segment) this.setMeta('run:segment_state', { ...segment, phase: 'stopped', ended_at: stoppedAt,
        termination_reason: 'user_stopped' });
      const report = this.getMeta('report:status', { state: 'not_started' });
      if (report.state === 'generating') this.setMeta('report:status', { ...report, state: 'stale', reason: 'user_stopped' });
      committed = true;
    });
    return committed;
  }
  claimRunning(expectedEpoch, expectedControl = this.getMeta('control'),
    expectedRevision = this.getMeta('control:revision', 0) || 0) {
    let claimed = null;
    this.transaction(() => {
      const current = this.getMeta('control:epoch', 0) || 0;
      if (current !== expectedEpoch || this.getMeta('control') !== expectedControl
          || (this.getMeta('control:revision', 0) || 0) !== expectedRevision) return;
      claimed = current + 1;
      this.setMeta('control:epoch', claimed);
      this.setMeta('control', 'running');
      this.setMeta('control:lease', claimed);
      if (this.getMeta('state') !== 'completed' || this.getMeta('goal:outcome') !== 'achieved') this.setMeta('state', 'running');
    });
    return claimed;
  }
  finishCompletedRun(candidate, reportID) {
    return this.transaction(() => {
      const view = this.ledgerData();
      const source = this.goalSource();
      const contract = this.getMeta('goal:contract');
      const evidence = this.evidenceStatus(view);
      const report = this.getMeta('report:status', { state: 'not_started' });
      const messageCutoff = Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id);
      if (this.getMeta('control') !== 'running'
          || (this.getMeta('control:epoch', 0) || 0) !== candidate.control_epoch
          || this.getMeta('control:lease') !== candidate.control_epoch
          || this.getMeta('state') !== 'completed'
          || this.getMeta('goal:outcome') !== 'achieved'
          || JSON.stringify(this.getMeta('goal:candidate')) !== JSON.stringify(candidate)
          || report.id !== reportID || !['complete', 'failed'].includes(report.state)
          || candidate.goal_source_fingerprint !== source.fingerprint
          || contract?.source?.fingerprint !== source.fingerprint
          || candidate.contract_revision !== contract?.revision
          || hash(JSON.stringify(contract)) !== candidate.contract_hash
          || view.snapshot !== candidate.ledger_snapshot
          || evidence.snapshot !== candidate.evidence_snapshot
          || messageCutoff !== candidate.message_cutoff
          || view.tasks.some(task => ['queued', 'reviewing', 'running'].includes(task.state))
          || view.tasks.some(task => task.state === 'accepted' && task.kind === 'work'
            && task.result?.followups?.length && !this.followupsComplete(task, this.followupGeneration(task, contract, source)))) {
        return false;
      }
      this.setMeta('control', 'paused');
      this.setMeta('control:lease', null);
      return true;
    });
  }
  commitGoalOutcome(candidate, { outcome, termination, assessment, report }) {
    if (!['achieved', 'not_established'].includes(outcome)) throw new Error(`잘못된 목표 결과: ${outcome}`);
    if (outcome === 'achieved' && assessment?.decision !== 'achieved') throw new Error('달성 후보 없이 목표 달성을 기록할 수 없습니다.');
    if (outcome !== 'achieved' && termination?.reason === 'goal_achieved') throw new Error('미입증 목표에 성공 종료 이유를 기록할 수 없습니다.');
    const committed = this.transaction(() => {
      const view = this.ledgerData();
      const messageCutoff = Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id);
      const contract = this.getMeta('goal:contract');
      const evidence = this.evidenceStatus(view);
      const source = this.goalSource();
      if (this.getMeta('control') !== 'running'
          || (this.getMeta('control:epoch', 0) || 0) !== candidate.control_epoch
          || this.getMeta('control:lease') !== candidate.control_epoch
          || candidate.goal_source_fingerprint !== source.fingerprint
          || contract?.source?.fingerprint !== source.fingerprint
          || view.snapshot !== candidate.ledger_snapshot
          || evidence.snapshot !== candidate.evidence_snapshot
          || messageCutoff !== candidate.message_cutoff
          || hash(JSON.stringify(contract)) !== candidate.contract_hash) return false;
      if (!contract || candidate.contract_revision !== contract.revision || assessment?.contract_revision !== contract.revision) {
        throw new Error('현재 목표 계약과 일치하지 않는 최종 판정입니다.');
      }
      const expected = contract.requirements.map(item => item.id);
      const sourceText = normalize(source.effective_text);
      if (contract.format_version !== 1 || expected.length < 2 || expected[0] !== 'G0'
          || new Set(expected).size !== expected.length
          || expected.slice(1).some((id, index) => id !== `R${index + 1}`)
          || !contract.objective?.trim()
          || contract.requirements.some(item => !['outcome', 'deliverable', 'constraint'].includes(item.type)
            || !item.statement?.trim() || !item.source_reference?.trim() || !item.verification?.trim())
          || Object.entries(goalAnchor).some(([key, value]) => contract.requirements[0][key] !== value)
          || contract.requirements.slice(1).some(item => !sourceText.includes(normalize(item.source_reference)))
          || contract.source?.fingerprint !== source.fingerprint || contract.source?.goal_sha256 !== source.goal_sha256) {
        throw new Error('비어 있거나 손상된 목표 계약으로 최종 판정을 기록할 수 없습니다.');
      }
      const contractReview = contract.review;
      const contractReviewed = Array.isArray(contractReview?.requirement_reviews)
        ? contractReview.requirement_reviews.map(item => item.requirement_id) : [];
      if (contractReview?.decision !== 'accept' || !Array.isArray(contractReview.missing_requirements)
          || contractReview.missing_requirements.length || new Set(contractReviewed).size !== contractReviewed.length
          || contractReviewed.length !== expected.length || contractReviewed.some(id => !expected.includes(id))
          || contractReview.requirement_reviews.some(item => item.verdict !== 'covered')) {
        throw new Error('독립 검토를 통과한 현재 목표 계약이 필요합니다.');
      }
      const evaluations = assessment?.requirement_evaluations || [];
      const evaluated = evaluations.map(item => item.requirement_id);
      if (new Set(evaluated).size !== evaluated.length || evaluated.length !== expected.length || evaluated.some(id => !expected.includes(id))) {
        throw new Error('최종 판정이 모든 필수 조건을 정확히 한 번 포함하지 않습니다.');
      }
      if (outcome === 'achieved') {
        if (view.tasks.some(task => ['queued', 'reviewing', 'running'].includes(task.state))) return false;
        if (view.tasks.some(task => task.state === 'accepted' && task.kind === 'work'
            && task.result?.followups?.length && !this.followupsComplete(task, this.followupGeneration(task, contract, source)))) {
          return false;
        }
        const verified = new Set(view.facts.filter(fact => fact.state === 'verified').map(fact => fact.id));
        if (evaluations.some(item => item.verdict !== 'satisfied' || !item.fact_ids.length
            || new Set(item.fact_ids).size !== item.fact_ids.length
            || item.fact_ids.some(id => !verified.has(id) || evidence.facts[id] !== true))) {
          throw new Error('모든 필수 조건에 현재 검증된 충족 근거가 있어야 목표를 달성 처리할 수 있습니다.');
        }
        const independent = assessment.independent_review;
        const reviewed = independent?.requirement_reviews?.map(item => item.requirement_id) || [];
        if (independent?.decision !== 'accept' || independent.contract_revision !== contract.revision
            || new Set(reviewed).size !== reviewed.length || reviewed.length !== expected.length
            || reviewed.some(id => !expected.includes(id))
            || independent.requirement_reviews.some(item => item.verdict !== 'accept')) {
          throw new Error('현재 계약 전체를 승인한 독립 완료 검토가 필요합니다.');
        }
      } else if (assessment?.decision !== 'concluded'
          || !['segment_budget_exhausted', 'goal_round_limit', 'no_progress', 'external_blocker', 'budget_exhausted'].includes(termination?.reason)) {
        throw new Error('미입증 종료에는 유효한 비성공 판정과 종료 이유가 필요합니다.');
      }
      this.setMeta('goal:assessment', assessment);
      this.setMeta('goal:candidate', candidate);
      this.setMeta('goal:pending_terminal', null);
      this.setMeta('goal:outcome', outcome);
      this.setMeta('run:termination', termination);
      this.setMeta('report:status', report);
      this.setMeta('state', outcome === 'achieved' ? 'completed' : 'suspended');
      const segment = this.getMeta('run:segment_state');
      if (segment) this.setMeta('run:segment_state', { ...segment,
        phase: outcome === 'achieved' ? 'completed' : 'suspended', ended_at: termination?.at || now(),
        termination_reason: termination?.reason || (outcome === 'achieved' ? 'goal_achieved' : null) });
      if (outcome !== 'achieved') {
        this.setMeta('control', 'paused');
        this.setMeta('control:lease', null);
      }
      return true;
    });
    return committed;
  }
  reopenGoalOutcome(candidate, reportID, reason = 'context_changed') {
    return this.transaction(() => {
      const savedCandidate = this.getMeta('goal:candidate');
      const report = this.getMeta('report:status', { state: 'not_started' });
      if (this.getMeta('control') !== 'running'
          || (this.getMeta('control:epoch', 0) || 0) !== candidate.control_epoch
          || this.getMeta('control:lease') !== candidate.control_epoch
          || this.getMeta('state') !== 'completed'
          || this.getMeta('goal:outcome') !== 'achieved'
          || JSON.stringify(savedCandidate) !== JSON.stringify(candidate)
          || report.id !== reportID) return false;
      this.setMeta('state', 'running');
      this.setMeta('goal:outcome', 'pending');
      this.setMeta('run:termination', null);
      this.setMeta('goal:candidate', null);
      this.setMeta('goal:pending_terminal', null);
      this.setMeta('report:status', { ...report, state: 'stale', reason });
      const segment = this.getMeta('run:segment_state');
      if (segment) this.setMeta('run:segment_state', { ...segment, phase: 'running', ended_at: null, termination_reason: null });
      return true;
    });
  }
  updateCommittedReport(candidate, reportID, report) {
    return this.transaction(() => {
      if (this.getMeta('control') !== 'running'
          || (this.getMeta('control:epoch', 0) || 0) !== candidate.control_epoch
          || this.getMeta('control:lease') !== candidate.control_epoch
          || this.getMeta('state') !== 'completed' || this.getMeta('goal:outcome') !== 'achieved'
          || JSON.stringify(this.getMeta('goal:candidate')) !== JSON.stringify(candidate)
          || this.getMeta('report:status')?.id !== reportID) return false;
      this.setMeta('report:status', report);
      return true;
    });
  }
  validDigests(view, scope) {
    const verified = new Set(view.facts.filter(fact => fact.state === 'verified').map(fact => fact.id));
    return view.digests.filter(digest => (!scope || digest.scope === scope || digest.scope.startsWith(scope + '.') || scope.startsWith(digest.scope + '.'))
      && digest.fact_ids.length && digest.fact_ids.every(id => verified.has(id)));
  }
  scopeIndex(view) {
    const valid = this.validDigests(view);
    const indexed = new Set(valid.flatMap(digest => digest.fact_ids));
    const scopes = [...new Set([...view.facts, ...view.tasks, ...view.digests].map(item => item.scope))].sort();
    return scopes.map(scope => {
      const facts = view.facts.filter(fact => fact.scope === scope);
      const verified = facts.filter(fact => fact.state === 'verified');
      return { scope, facts: facts.length, verified: verified.length,
        indexed: verified.filter(fact => indexed.has(fact.id)).length,
        unindexed: verified.filter(fact => !indexed.has(fact.id)).length,
        digests: valid.filter(digest => digest.scope === scope).length };
    });
  }
  taskRecord(task) {
    const { id, title, brief, scope, kind, state, dependencies, revisions, failures, feedback, result } = task;
    return { id, title, brief, scope, kind, state, dependencies, revisions, failures, feedback,
      resources: task.resources, logical_key: task.logical_key,
      result: result ? { summary: result.summary, fact_ids: result.fact_ids,
        artifacts: (result.artifacts || []).map(artifact => {
          const file = path.join(this.directory, 'tasks', 'T' + id, 'outputs', artifact.path);
          const exists = fs.existsSync(file) && fs.statSync(file).isFile();
          return { path: file, exists, bytes: exists ? fs.statSync(file).size : 0,
            expected_sha256: hash(artifact.content), actual_sha256: exists ? hash(fs.readFileSync(file)) : null };
        }) } : null };
  }
  knowledgeContext(view, characters, scope) {
    const scopes = this.scopeIndex(view).filter(item => !scope || item.scope === scope || item.scope.startsWith(scope + '.') || scope.startsWith(item.scope + '.'));
    // Filter by scope before applying any budget; give each scope a turn before
    // including additional batches from the same scope.
    const digests = this.validDigests(view, scope).toReversed();
    const seen = new Set(), first = [], rest = [];
    for (const digest of digests) {
      (seen.has(digest.scope) ? rest : first).push(digest); seen.add(digest.scope);
    }
    const scopePack = boundedJSON(scopes, Math.floor(characters / 3));
    const digestPack = boundedJSON([...first, ...rest], characters - Math.floor(characters / 3));
    const { items: scopeItems, ...scopeCoverage } = scopePack;
    const { items: digestItems, ...digestCoverage } = digestPack;
    return { snapshot: view.snapshot, as_of: view.as_of, scopes: scopeItems, digests: digestItems,
      coverage: { scopes: scopeCoverage, digests: digestCoverage },
      lookup: { tool: 'ledger_page', snapshot: view.snapshot, collections: ['facts', 'tasks', 'digests', 'scopes'] } };
  }
  ledgerPage({ collection, scope, state, snapshot, offset = 0, limit = 20 } = {}) {
    if (!['facts', 'tasks', 'digests', 'scopes'].includes(collection)) throw new Error('알 수 없는 원장 collection');
    if (scope !== undefined && typeof scope !== 'string') throw new Error('scope는 문자열이어야 합니다.');
    if (state !== undefined && (typeof state !== 'string' || !['facts', 'tasks'].includes(collection))) throw new Error('state는 facts/tasks에만 사용할 수 있습니다.');
    offset = integer(offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    limit = integer(limit, 'limit', 1, 50);
    if (offset && !snapshot) throw new Error('다음 페이지에는 첫 페이지의 snapshot이 필요합니다.');
    const view = this.ledgerView();
    const evidence = collection === 'facts' ? this.evidenceStatus(view) : null;
    if (snapshot !== undefined && snapshot !== view.snapshot) throw new Error('원장이 변경되었습니다. snapshot을 생략하고 offset=0부터 다시 조회하세요.');
    let rows = collection === 'scopes' ? this.scopeIndex(view) : collection === 'digests' ? this.validDigests(view) : view[collection];
    rows = rows.filter(row => (!scope || row.scope === scope || row.scope.startsWith(scope + '.')) && (!state || row.state === state));
    const items = [];
    let characters = 2;
    for (const row of rows.slice(offset, offset + limit)) {
      const item = collection === 'tasks' ? this.taskRecord(row) : collection === 'facts'
        ? (({ id, key, scope, kind, state, claim }) => ({ id, key, scope, kind, state, claim,
          current_evidence: evidence.facts[id] === true }))(row) : row;
      const size = JSON.stringify(item).length + (items.length ? 1 : 0);
      // Pages must be contiguous. Always return a first oversized item so callers
      // can advance without silently skipping a record.
      if (items.length && characters + size > 12000) break;
      items.push(item); characters += size;
    }
    const next = offset + items.length;
    return { collection, scope: scope ?? null, state: state ?? null, snapshot: view.snapshot, as_of: view.as_of,
      total: rows.length, included: items.length, truncated: items.length < rows.length,
      offset, next_offset: next < rows.length ? next : null, over_budget: characters > 12000, items };
  }
  search(query, { limit = 12, scope } = {}) {
    const terms = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) || [];
    if (!terms.length) return this.listFacts({ scope, limit, state: 'verified' });
    const expression = terms.slice(0, 12).map(term => '"' + term + '"').join(' OR ');
    const rows = this.db.prepare(`SELECT f.id FROM fact_search JOIN facts f ON f.id=fact_search.rowid
      WHERE fact_search MATCH ? ORDER BY bm25(fact_search) LIMIT ?`).all(expression, Math.min(500, limit * 4));
    return rows.map(row => this.fact(row.id)).filter(fact => !scope || fact.scope === scope || fact.scope.startsWith(scope + '.')).slice(0, limit);
  }
  checkEvidence(facts) {
    for (const fact of facts) {
      if (!fact.evidence.length) throw new Error(`F${fact.id}: 증거 누락`);
      for (const evidence of fact.evidence) if (hash(fs.readFileSync(evidence.artifact)) !== evidence.sha256) throw new Error(`F${fact.id}: 증거 해시 불일치`);
    }
  }
  applyVerdict(taskID, verdict, expectedIDs, { expectedState = null, taskPatch = null } = {}) {
    validate(verdict, schemas.supervisor);
    const ids = verdict.fact_verdicts.map(item => item.id);
    if (new Set(ids).size !== ids.length || ids.length !== expectedIDs.length || ids.some(id => !expectedIDs.includes(id))) {
      throw new Error('검토 결과는 모든 제출 사실을 정확히 한 번 판정해야 합니다.');
    }
    const conflictReview = this.task(taskID).kind === 'conflict';
    if (!conflictReview && verdict.fact_verdicts.some(item => item.state === 'superseded')) throw new Error('동등한 주장 병합은 별도의 충돌 검토에서만 할 수 있습니다.');
    if (verdict.fact_verdicts.some(item => item.state === 'superseded') && verdict.fact_verdicts.filter(item => item.state === 'verified').length !== 1) throw new Error('병합에는 하나의 검증된 대표 주장이 필요합니다.');
    if (verdict.decision === 'accept') {
      if (conflictReview) {
        if (verdict.fact_verdicts.some(item => item.state === 'unresolved') || verdict.fact_verdicts.filter(item => item.state === 'verified').length !== 1) throw new Error('충돌 해결에는 하나의 확인된 주장과 나머지 주장에 대한 반박이 필요합니다.');
      } else if (verdict.fact_verdicts.some(item => item.state !== 'verified')) throw new Error('미검증/반박 사실이 있는 작업을 승인할 수 없습니다.');
    }
    this.checkEvidence(expectedIDs.map(id => this.fact(id)));
    if (taskPatch) {
      const allowed = new Set(['state', 'revisions', 'failures', 'result', 'feedback']);
      if (!Object.keys(taskPatch).length || Object.keys(taskPatch).some(key => !allowed.has(key))) throw new Error('잘못된 task patch');
    }
    const committed = this.transaction(() => {
      if (expectedState && this.task(taskID).state !== expectedState) return false;
      for (const item of verdict.fact_verdicts) {
        const previous = this.fact(item.id);
        // Repeated submissions cannot erase an independently confirmed result with "unresolved".
        const state = item.state === 'unresolved' ? (previous.state === 'verified' ? 'verified' : 'proposed') : item.state;
        const canonical = state === 'superseded' ? verdict.fact_verdicts.find(candidate => candidate.state === 'verified')?.id : null;
        const reason = canonical ? `${item.reason} [canonical F${canonical}]` : item.reason;
        this.db.prepare('UPDATE facts SET state=?,reason=? WHERE id=?').run(state, reason, item.id);
      }
      const keys = [...new Set(expectedIDs.map(id => this.fact(id).key))];
      for (const key of keys) {
        const positive = this.db.prepare("SELECT id FROM facts WHERE key=? AND state IN ('verified','conflicted')").all(key);
        if (positive.length > 1) this.db.prepare("UPDATE facts SET state='conflicted' WHERE key=? AND state IN ('verified','conflicted')").run(key);
        else if (positive.length === 1) this.db.prepare("UPDATE facts SET state='verified' WHERE id=?").run(positive[0].id);
      }
      if (taskPatch) {
        const entries = Object.entries(taskPatch);
        this.db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
          .run(...entries.map(([key, value]) => key === 'result' && value !== null ? JSON.stringify(value) : value), taskID);
      }
      return true;
    });
    if (!committed) {
      this.event('facts.review_discarded', { task: taskID, reason: 'task_changed_during_review' });
      return false;
    }
    this.event('facts.reviewed', { task: taskID, decision: verdict.decision, verdicts: verdict.fact_verdicts });
    if (taskPatch?.state) this.event('task.state', { task: taskID, state: taskPatch.state, reason: taskPatch.feedback || '' });
    return true;
  }
  context(task, characters = 12000) {
    const view = this.ledgerView();
    const evidenceStatus = this.evidenceStatus(view);
    const byID = new Map(view.facts.map(fact => [fact.id, fact]));
    const relevant = this.search(task.scope + ' ' + task.brief, { limit: 50 }).map(fact => byID.get(fact.id)).filter(Boolean);
    const inherited = view.facts.filter(fact => fact.origins.some(id => task.dependencies.includes(id)));
    const scoped = view.facts.filter(fact => fact.scope === task.scope || fact.scope.startsWith(task.scope + '.'));
    const facts = [...new Map([...inherited, ...relevant, ...scoped].map(fact => [fact.id, fact])).values()]
      .filter(fact => ['verified', 'conflicted'].includes(fact.state));
    const compact = fact => ({ id: fact.id, key: fact.key, kind: fact.kind, state: fact.state, claim: fact.claim,
      current_evidence: evidenceStatus.facts[fact.id] === true,
      evidence: fact.evidence.slice(0, 2).map(item => ({ artifact: item.artifact, sha256: item.sha256 })) });
    const knowledge = this.knowledgeContext(view, Math.floor(characters / 4), task.scope);
    const { items, ...coverage } = boundedJSON(facts.map(compact), Math.floor(characters * 3 / 4));
    return { ...knowledge, facts: items, coverage: { ...knowledge.coverage, facts: { ...coverage,
      selection: 'dependency, scope, or ranked search', ledger_total: view.facts.length } } };
  }
  curationProgress(scope, view = this.ledgerView()) {
    const digests = this.validDigests(view).filter(digest => digest.scope === scope);
    const digestIDs = new Set(digests.map(digest => digest.id));
    const indexed = new Set(digests.flatMap(digest => digest.fact_ids));
    // Old curated_ids markers are unreliable. Existing valid digest citations
    // are the only legacy records that prove successful inclusion.
    const batches = this.getMeta('curation_batches:' + scope, []).filter(batch => digestIDs.has(batch.digest_id));
    const processed = new Set([...indexed, ...batches.flatMap(batch => batch.input_ids)]);
    const current = view.facts.filter(fact => fact.scope === scope && fact.state === 'verified');
    return { delivered_ids: this.getMeta('curation_delivered:' + scope, []),
      processed_ids: current.filter(fact => processed.has(fact.id)).map(fact => fact.id),
      indexed_ids: current.filter(fact => indexed.has(fact.id)).map(fact => fact.id),
      unindexed_ids: current.filter(fact => !indexed.has(fact.id)).map(fact => fact.id) };
  }
  addDigest(digest, { emitEvent = true } = {}) {
    validate(digest, schemas.curator);
    if (digest.summary.length > 1600 || !digest.summary.trim()) throw new Error('요약은 1600자 이하의 비어 있지 않은 문자열이어야 합니다.');
    if (!digest.fact_ids.length || new Set(digest.fact_ids).size !== digest.fact_ids.length || digest.fact_ids.some(id => this.fact(id).state !== 'verified')) throw new Error('요약에는 중복 없는 현재 검증된 사실 ID가 필요합니다.');
    const id = Number(this.db.prepare('INSERT INTO digests(scope,summary,fact_ids,created) VALUES (?,?,?,?)').run(digest.scope, digest.summary, JSON.stringify(digest.fact_ids), now()).lastInsertRowid);
    if (emitEvent) this.event('digest.updated', { scope: digest.scope, facts: digest.fact_ids });
    return id;
  }
  message(text, target = 'all') {
    if (!text.trim()) throw new Error('추가 지시가 비어 있습니다.');
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('추가 지시는 UTF-8 2MB 이하로 입력하세요.');
    const taskTarget = target === 'all' ? null : Number(target);
    if (taskTarget !== null && (!Number.isSafeInteger(taskTarget) || taskTarget < 1)) throw new Error('추가 지시의 task 대상이 잘못됐습니다.');
    const normalizedTarget = taskTarget === null ? 'all' : String(taskTarget);
    let reopenedTask = null;
    const id = this.transaction(() => {
      const task = taskTarget === null ? null : this.task(taskTarget);
      if (task && task.state !== 'queued') {
        this.db.prepare("UPDATE tasks SET state='queued',result=NULL,failures=0,revisions=0,feedback=? WHERE id=?")
          .run('추가 사용자 지시에 따라 작업을 다시 확인합니다.', task.id);
        reopenedTask = task.id;
      }
      const result = this.db.prepare('INSERT INTO messages(target,text,created) VALUES (?,?,?)').run(normalizedTarget, text, now());
      this.reopenCompletedForWork('instruction_added_after_completion');
      return Number(result.lastInsertRowid);
    });
    if (reopenedTask !== null) this.event('task.state', { task: reopenedTask, state: 'queued', reason: '추가 사용자 지시에 따라 작업을 다시 확인합니다.' });
    this.event('user.instruction', { message: id, target: normalizedTarget, text });
    return id;
  }
  messages(taskID) {
    return this.db.prepare("SELECT * FROM messages WHERE target='all' OR target=? ORDER BY id").all(String(taskID));
  }
  pendingMessages(attemptID, taskID) {
    return this.messages(taskID).filter(message => !this.db.prepare('SELECT 1 FROM deliveries WHERE message_id=? AND attempt_id=?').get(message.id, attemptID));
  }
  delivered(messageID, attemptID, state) {
    this.db.prepare('INSERT INTO deliveries VALUES (?,?,?) ON CONFLICT(message_id,attempt_id) DO UPDATE SET state=excluded.state').run(messageID, attemptID, state);
  }
  beginAttempt(taskID, role, provider) {
    return Number(this.db.prepare('INSERT INTO attempts(task_id,role,provider,created) VALUES (?,?,?,?)').run(taskID || null, role, provider, now()).lastInsertRowid);
  }
  attemptCount({ includeEditor = true } = {}) {
    const row = includeEditor
      ? this.db.prepare('SELECT COUNT(*) AS count FROM attempts').get()
      : this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE role<>'editor'").get();
    return Number(row.count);
  }
  session(attemptID, sessionID, turnID = null) {
    this.db.prepare('UPDATE attempts SET session_id=?,turn_id=? WHERE id=?').run(sessionID, turnID, attemptID);
  }
  endAttempt(attemptID, state) {
    this.db.prepare('UPDATE attempts SET state=?,ended=? WHERE id=?').run(state, now(), attemptID);
  }
  interruptedSession(taskID, provider) {
    return this.db.prepare("SELECT session_id FROM attempts WHERE task_id=? AND role='worker' AND provider=? AND state='interrupted' AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(taskID, provider)?.session_id;
  }
  recover() {
    this.db.prepare("UPDATE attempts SET state='interrupted',ended=? WHERE state='running'").run(now());
    this.db.prepare("UPDATE tasks SET state=CASE WHEN result IS NULL THEN 'queued' ELSE 'reviewing' END WHERE state='running'").run();
  }
}
