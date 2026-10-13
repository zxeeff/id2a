import test from 'node:test';
import assert from 'node:assert/strict';
import { makePrompt } from '../src/prompts.mjs';

const base = {
  goal: 'Implement and verify the requested change.',
  workspace: 'C:\\project',
  directory: 'C:\\runs\\task',
};

function dataFrom(prompt) {
  return JSON.parse(prompt.split('Assigned data (JSON):\n')[1]);
}

test('prompts keep the workflow contract concise and role-specific', () => {
  const roles = ['planner', 'worker', 'supervisor', 'triage', 'goal', 'curator', 'editor'];
  for (const role of roles) {
    const prompt = makePrompt(role, base);
    assert.match(prompt, new RegExp(`^Role: ${role}$`, 'mu'));
    assert.match(prompt, /Return exactly one complete JSON object matching the supplied schema/u);
    assert(prompt.length < 2200, `${role} prompt boilerplate is ${prompt.length} characters`);
    assert.doesNotMatch(prompt, /autonomous intrusion|offensive.security|Never modify ID2A|Do not delegate|across as many cycles as necessary/iu);
  }

  assert.match(makePrompt('worker', base), /absolute paths for source-workspace evidence/u);
  assert.match(makePrompt('worker', base), /read it directly with workspace_read/u);
  assert.match(makePrompt('worker', base), /assigned task scope or a dot-separated child scope/u);
  assert.match(makePrompt('worker', base), /outputs\/<path> evidence/u);
  assert.match(makePrompt('worker', base), /never write artifact files with tools/u);
  assert.match(makePrompt('supervisor', base), /evidence_read/u);
  assert.match(makePrompt('goal', base), /completion gate/u);
  assert.match(makePrompt('curator', base), /Copy context\.scope verbatim/u);
});

test('assigned data preserves only the inputs available to a role', () => {
  const prompt = makePrompt('worker', {
    ...base,
    task: { id: 2, title: 'Implement', brief: 'Make the change.', scope: 'app.change' },
    context: { facts: [] },
    facts: [],
    feedback: 'Cover the edge case.',
    candidate: { title: 'Followup' },
    instructions: [{ id: 7, text: 'Use the existing helper.' }],
  });
  assert.deepEqual(dataFrom(prompt), {
    goal: base.goal,
    task: { id: 2, title: 'Implement', brief: 'Make the change.', scope: 'app.change' },
    context: { facts: [] },
    facts: [],
    revision_feedback: 'Cover the edge case.',
    proposal: { title: 'Followup' },
    user_instructions: [{ id: 7, text: 'Use the existing helper.' }],
  });
});

test('input policy changes autonomy without duplicating policy boilerplate', () => {
  const continuousGoal = makePrompt('goal', base);
  const waitingGoal = makePrompt('goal', { ...base, inputPolicy: 'wait' });
  assert.match(continuousGoal, /never return needs_input/u);
  assert.doesNotMatch(waitingGoal, /never return needs_input/u);
  assert.match(waitingGoal, /Return needs_input only when no productive work can continue/u);

  assert.match(makePrompt('planner', base), /Execution mode: autonomous/u);
  assert.match(makePrompt('worker', { ...base, inputPolicy: 'wait' }), /Execution mode: interactive only when blocked/u);
  assert.throws(() => makePrompt('worker', { ...base, inputPolicy: 'invalid' }), /Unknown input policy/u);
  assert.throws(() => makePrompt('unknown', base), /Unknown role/u);
});
