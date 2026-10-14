import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexSession, ClaudeSession } from '../src/providers.mjs';

const workspace = path.resolve(fileURLToPath(new URL('../examples/', import.meta.url)));
const schema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};
const prompt = 'Run the read-only command `git --version`, then return only the required JSON object with the exact command output in value.';

const runs = [
  ['codex', new CodexSession({ cwd: workspace }), { model: 'gpt-5.6-sol', effort: 'low' }],
  ['claude', new ClaudeSession({ cwd: workspace }), { effort: 'auto' }],
];
const results = [];
for (const [provider, session, settings] of runs) {
  const result = await session.run({ prompt, schema, permissions: 'yolo', readOnly: true, ...settings });
  if (!/^git version /u.test(result.value)) throw new Error(`${provider}: git --version 결과를 확인하지 못했습니다: ${result.value}`);
  results.push({ provider, permissions: provider === 'codex' ? 'danger-full-access' : 'dangerously-skip-permissions', result: result.value });
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
