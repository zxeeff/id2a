import readline from 'node:readline';
import fs from 'node:fs';
const codex = process.argv.includes('app-server');
const claudeYolo = process.argv.includes('--dangerously-skip-permissions');
const claudeRestricted = process.argv.includes('--allowedTools');
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const lines = readline.createInterface({ input: process.stdin });
let turn = 0, text = '', timer, queue = Promise.resolve(), codexSandbox = '';
lines.on('line', line => {
  const message = JSON.parse(line);
  if (codex) {
    const respond = result => output({ id: message.id, result });
    if (message.method === 'initialize') respond({ userAgent: 'fixture' });
    else if (message.method === 'model/list') respond({ data: [{ id: 'fixture', model: 'fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      codexSandbox = message.params.sandbox;
      respond({ thread: { id: message.params.threadId || 'fixture-session' }, model: 'fixture' });
    }
    else if (message.method === 'turn/start') {
      const id = 'turn-' + ++turn;
      text = message.params.input[0].text;
      respond({ turn: { id } }); output({ method: 'turn/started', params: { turn: { id } } });
      timer = setTimeout(() => {
        if (text.includes('[fail]')) { output({ method: 'turn/completed', params: { turn: { id, status: 'failed', error: { message: 'fixture failed' } } } }); return; }
        const value = text.includes('[sandbox]') ? codexSandbox : text.includes('updated') ? 'updated' : 'initial';
        const result = text.includes('[invalid]') ? 'invalid' : JSON.stringify({ value });
        output({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: result } });
        output({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: result } } });
        output({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
      }, 300);
    } else if (message.method === 'turn/steer') { text += message.params.input[0].text; respond({ turnId: 'turn-' + turn }); }
  } else if (message.type === 'user') {
    const currentText = message.message.content;
    queue = queue.then(async () => {
      output({ type: 'system', subtype: 'init', session_id: 'fixture-claude-session' });
      await new Promise(resolve => setTimeout(resolve, 200));
      output({ type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-claude-session',
        structured_output: { value: currentText.includes('[permissions]') ? `${claudeYolo ? 'yolo' : 'limited'}-${claudeRestricted ? 'restricted' : 'unrestricted'}` : currentText.includes('updated') ? 'updated' : 'initial' }, usage: { input_tokens: currentText.length, output_tokens: 2 } });
    });
  }
});
lines.on('close', () => { clearTimeout(timer); queue.then(() => process.exit(0)); });
