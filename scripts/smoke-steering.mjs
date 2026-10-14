// Opt-in real CLI verification. This makes small authenticated model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexSession, ClaudeSession } from '../src/providers.mjs';
import { configuration } from '../src/engine.mjs';
import { within, writeJSON } from '../src/util.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'id2a-steering-'));
const codexModel = configuration({ workspace: directory }).model;
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
const results = [];
try {
  for (const [provider, Constructor] of [['codex', CodexSession], ['claude', ClaudeSession]]) {
    let session, steering, submitted = false;
    session = new Constructor({
      cwd: directory,
      onSession: (_sessionID, turnID) => {
        if (submitted || (provider === 'codex' && !turnID)) return;
        submitted = true;
        steering = session.steer('New user instruction: return {"value":"updated"} as your complete replacement final JSON. Do not use tools.');
        steering.catch(() => {});
      },
    });
    const result = await session.run({
      prompt: 'Return {"value":"initial"} as final JSON. Do not use any tools, files, commands, or additional agents.',
      schema, readOnly: true, effort: 'low', ...(provider === 'codex' ? { model: codexModel } : {}),
    });
    assert.equal(result.value, 'updated');
    const state = await steering;
    assert.equal(state, provider === 'codex' ? 'accepted' : 'queued');
    const record = { provider, model: provider === 'codex' ? codexModel : null, effort: 'low', instruction: state, result, passed: true, at: new Date().toISOString() };
    results.push(record);
    console.log(JSON.stringify(record));
  }
  writeJSON(fileURLToPath(new URL('../steering-verification.json', import.meta.url)), results);
} finally {
  if (fs.existsSync(directory) && within(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory)) && path.basename(directory).startsWith('id2a-steering-')) fs.rmSync(directory, { recursive: true, force: true });
}
