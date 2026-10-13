const text = { type: 'string' };
export const goalAnchor = Object.freeze({
  id: 'G0', type: 'outcome',
  statement: 'The original goal and all applicable later user instructions are fulfilled in full.',
  source_reference: 'controller goal anchor',
  verification: 'Compare the actual current result directly with the full effective user request and cite verified evidence that establishes the requested outcome.',
});
const array = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumeration = values => ({ type: 'string', enum: values });
export const taskSchema = object({ title: text, brief: text, scope: text });
export const plannedTaskSchema = object({ ...taskSchema.properties, depends_on: array({ type: 'integer' }) });
const contractRequirementSchema = object({
  type: enumeration(['outcome', 'deliverable', 'constraint']),
  statement: text,
  source_reference: text,
  verification: text,
});
const requirementEvaluationSchema = object({
  requirement_id: text,
  verdict: enumeration(['satisfied', 'unsatisfied', 'unknown']),
  fact_ids: array({ type: 'integer' }),
  reason: text,
});
export const schemas = {
  contract: object({ objective: text, requirements: array(contractRequirementSchema) }),
  contract_review: object({
    decision: enumeration(['accept', 'revise']),
    reason: text,
    requirement_reviews: array(object({
      requirement_id: text,
      verdict: enumeration(['covered', 'weakened', 'unsupported']),
      reason: text,
    })),
    missing_requirements: array(object({ statement: text, source_reference: text, reason: text })),
  }),
  planner: object({ summary: text, tasks: array(plannedTaskSchema) }),
  worker: object({
    summary: text,
    artifacts: array(object({ path: text, content: text })),
    facts: array(object({ key: text, scope: text, kind: enumeration(['observation', 'dead_end']), claim: text,
      evidence: array(object({ path: text, note: text })) })),
    followups: array(taskSchema),
  }),
  supervisor: object({ decision: enumeration(['accept', 'revise', 'reject']), reason: text,
    fact_verdicts: array(object({ id: { type: 'integer' }, state: enumeration(['verified', 'refuted', 'unresolved', 'superseded']), reason: text })) }),
  triage: object({ decision: enumeration(['approve', 'reject']), reason: text }),
  goal: object({
    decision: enumeration(['achieved', 'continue', 'needs_input']),
    contract_revision: { type: 'integer' },
    requirement_evaluations: array(requirementEvaluationSchema),
    reason: text,
    progress: text,
    next_tasks: array(plannedTaskSchema),
    question: text,
  }),
  goal_review: object({
    decision: enumeration(['accept', 'reject']),
    contract_revision: { type: 'integer' },
    reason: text,
    requirement_reviews: array(object({
      requirement_id: text,
      verdict: enumeration(['accept', 'reject']),
      reason: text,
    })),
  }),
  curator: object({ scope: text, summary: text, fact_ids: array({ type: 'integer' }) }),
  editor: object({ title: text, body: text, fact_ids: array({ type: 'integer' }) }),
};

// The CLI's schema enforcement is supplemented by validation at the write boundary.
export function validate(value, schema, location = 'result') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location}: object 필요`);
    for (const required of schema.required || []) if (!(required in value)) throw new Error(`${location}.${required}: 누락`);
    for (const key of Object.keys(value)) {
      if (!schema.properties[key]) throw new Error(`${location}.${key}: 알 수 없는 필드`);
      validate(value[key], schema.properties[key], `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${location}: array 필요`);
    for (const [index, item] of value.entries()) validate(item, schema.items, `${location}[${index}]`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${location}: integer 필요`);
  } else if (typeof value !== schema.type) throw new Error(`${location}: ${schema.type} 필요`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location}: 허용되지 않은 값 ${value}`);
  return value;
}
export function parseResult(textValue, schema) {
  const stripped = textValue.trim().replace(/^```(?:json)?\s*\n/iu, '').replace(/\n```\s*$/u, '');
  return validate(JSON.parse(stripped), schema);
}
