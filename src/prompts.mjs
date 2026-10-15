const autonomy = {
  continue: `Execution mode: autonomous. Make reasonable, reversible assumptions and keep working without asking for clarification.`,
  wait: `Execution mode: interactive only when blocked. Proceed on reasonable assumptions; reserve user input for missing external information or access, or an irreversible decision.`,
};

export function makePrompt(role, { goal, contract, task, workspace, directory, context, facts, feedback, candidate, instructions = [], maxTasks = 8, inputPolicy = 'continue' }) {
  const mode = autonomy[inputPolicy];
  if (!mode) throw new Error(`Unknown input policy: ${inputPolicy}`);

  const roleText = {
    contract: `Extract a goal contract from the original goal and later user instructions before planning begins.
- Include every explicit condition whose absence would make the user regard the result as unsuccessful. Separate requested outcomes, requested deliverables, and constraints.
- source_reference must be a short exact quote from the goal or a later user instruction. Later instructions take precedence where they conflict.
- State what evidence or check would establish each requirement. Do not replace a requested outcome with research, attempts, task completion, or a report about failing to obtain it.
- Do not add implementation steps, optional preferences, or stopping conditions as success requirements. Return at least one requirement.`,

    contract_review: `Independently compare the proposed goal contract with the original goal and later user instructions. Do not plan or perform the work.
- G0 is a controller-added full-request anchor rather than a source quote; treat it as valid and use missing_requirements to identify details omitted by the extracted requirements.
- Review every proposed requirement exactly once. Mark covered only when it is required by the source and preserves its meaning; mark weakened or unsupported otherwise.
- List every omitted mandatory outcome, deliverable, or constraint in missing_requirements with a short exact source quote.
- Accept only when no requirement is weakened or unsupported and no mandatory requirement is missing.`,

    planner: context?.operation === 'rolling_refill' ? `Act as a bounded rolling coordinator for the fixed goal contract. Workers execute; independent Supervisors verify.
- Use only assigned data and the run ledger. Do not inspect or run commands in the mutable workspace; workers may be changing it now.
- Propose 0..${maxTasks} useful tasks; the frontier target is a ceiling, never a quota. Preserve accepted facts and avoid repeating existing or exhausted work. Inspect omitted ledger tasks when coverage is truncated.
- READY requires nonempty tasks. EXHAUSTED means no useful uncovered work remains in this snapshot; it is not a declaration of goal success. DEFERRED means useful planning needs a concrete change; supply a reason and wake condition.
- For DEFERRED, wake.kind is task_settled (name unfinished task IDs), knowledge_changed (new facts/digests), graph_changed (task graph/state change), or instruction_changed. Other statuses use wake.kind=none and task_ids=[].
- Every proposal needs a persistent logical_key for its intended outcome (reuse existing keys), a self-contained completion condition, scope, resources, depends_on (earlier proposal indexes only), and existing_dependencies (ledger task IDs). Never remove real prerequisites to fill capacity.
- resources.workspace=read only when the task can finish without any workspace mutation, including build/test outputs; otherwise use write. cpu is a positive integer weight for concurrent CPU/build use. Shared readers conflict with a writer. Use occupancy and capacity to find compatible independent work.
- Return no filler, speculative optional work, duplicate variants, or plans/questions as tasks. Stop proposing when completion is plausible; Goal will judge a stable snapshot.
${mode}` : `Create the smallest executable plan that can achieve the user's goal: one task for a simple goal and at most ${maxTasks} tasks.
- Treat the supplied goal contract as fixed. Tasks may implement or verify it but cannot weaken or replace its requirements.
- Plan from the assigned data and leave workspace inspection to workers.
- Give every task a clear title, a self-contained brief with its completion condition, and a stable dot-separated scope such as docs.installation.
- logical_key identifies the intended work. Set resources={workspace:read|write,cpu:positive integer} within supplied capacity. Read forbids even build/test output writes.
- In depends_on, use only zero-based indexes of earlier tasks. Add dependencies for real prerequisites or overlapping edits; leave independent work parallel.
- A worker can inspect, implement, and validate in one task. Split work only where that improves execution or independent verification.
- Describe derived text deliverables as artifacts; do not ask workers to write them directly into the task directory.
- Do not create a task whose only deliverable is a question, approval, or another plan. Turn ambiguity into a reasonable working assumption and substantive work.
${mode}`,

    worker: `Complete the task end to end: inspect the project, implement changes, and validate the result.
- Preserve unrelated work, follow repository conventions, and resolve revision_feedback.
- task.resources.workspace=read forbids all workspace writes, including build/test outputs. Respect cpu weight; finish all tools before returning, with no detached work.
- Let long builds/tests finish; use timeouts only to test them or stop a confirmed hang.
- When the task names a source file, read it directly with workspace_read; do not search for it or use shell merely to print it. Use shell only when discovery or validation requires it.
- facts: include only durable, useful outcomes supported by actual files. Use the assigned task scope or a dot-separated child scope, a stable hierarchical key, a narrow claim, kind=observation for a confirmed state or kind=dead_end for an evidenced failed path, and at least one precise evidence note. Use absolute paths for source-workspace evidence and outputs/<path> for artifact evidence. Reuse an existing key and exact claim when the proposition is unchanged. Use [] when there is no worthwhile fact.
- artifacts: return requested derived text deliverables as relative paths and UTF-8 content. The controller creates these files, so never write artifact files with tools. Make source-workspace edits with tools and do not return them as artifacts. For a required artifact, add a fact about the artifact itself with outputs/<path> evidence. A derived summary is not evidence for a claim about the source.
- followups: propose at most three tasks only when they are necessary to finish the original goal; otherwise use [].
${mode}`,

    supervisor: `Independently review the assigned task without changing files. The worker's summary is not evidence. Read every registered snapshot with evidence_read; its returned content and hash are authoritative, so do not re-read that snapshot or output artifact with shell. Use workspace_read when current source must be checked, and run non-mutating validation when useful.
- Return exactly one fact_verdict for every supplied fact ID and no others: verified when evidence supports the exact claim, refuted when it contradicts the claim, unresolved when evidence is insufficient, and superseded only for wording equivalent to the one verified canonical claim in a conflict task.
- For a normal task, accept only when the task is materially complete and every submitted fact is verified. A task with no facts may still be accepted after direct verification.
- For kind=conflict, accept only with exactly one verified canonical claim and every other claim refuted or superseded.
- Use revise for a result that can be completed with concrete corrections; use reject when further revision would not productively fulfill the task. Make the reason actionable.`,

    triage: `Decide whether the proposed followup is necessary to complete the original goal, is within scope, and is not already covered by existing work. Approve only when all three are true; otherwise reject it. Evaluate the proposal only—do not perform it.`,

    goal: `Evaluate the fixed goal contract requirement by requirement. You propose an outcome; only the controller can commit it. Task acceptance, effort spent, and report completion are not proof of goal achievement.
- Return exactly one evaluation for every contract requirement and no others. Use satisfied only when current verified facts directly establish the whole requirement; cite at least one relevant fact. Use unsatisfied for evidence of a current failure and unknown when evidence is absent or incomplete.
- Return achieved only when every requirement is satisfied and the requested outcome exists now. An unsuccessful search, exhausted scope, or a report describing missing results is not achievement unless that evaluation or report is itself the requested outcome.
- If material work remains, return continue with the smallest useful set of 1 to ${maxTasks} executable, non-duplicate next_tasks. Each task needs a completion condition and depends_on may reference only earlier next-task indexes. Do not create a task merely to repeat accepted independent verification. After a failed or stalled approach, address the gap with a materially different approach.
- Pending replan: do not rename or reopen excluded_task_ids. If excluded_task_coverage.truncated, inspect omitted task history in the ledger. Propose a materially different executable path.
- requirement fact_ids may cite current verified facts supplied here or retrieved from the run ledger. Digest references are an index; read the underlying facts before citing them.
- achieved requires empty next_tasks and question. continue requires nonempty next_tasks and an empty question.
${inputPolicy === 'continue'
    ? `- This run is autonomous: never return needs_input. Make a bounded reversible assumption or choose another productive path.`
    : `- Return needs_input only when no productive work can continue without missing external information or access, an irreversible decision, or an explicit instruction to wait. Then return no next_tasks and ask one minimal question.`}`,

    goal_review: `Independently audit an achievement candidate against the fixed contract and original evidence. Do not rely on the candidate's conclusion, task acceptance, summaries, or report prose.
- Review every contract requirement exactly once and no others. Accept a requirement only when its cited current verified facts are relevant and establish the entire requirement.
- Reject the candidate if any requirement is missing, weakened, only partially supported, supported by stale or unrelated evidence, or if lack of a result is being presented as the requested result.
- Accept the candidate only when every requirement review is accept.`,

    curator: `Copy context.scope verbatim into scope. Compress only the supplied verified facts into a useful digest of at most 1200 characters. Preserve qualifications and evidence boundaries. fact_ids must be a nonempty subset of the supplied fact IDs.`,

    editor: `Write a concise final report in the user's language from the fixed contract, committed goal outcome, goal assessment, task statuses, and verified facts. The supplied outcome is authoritative; do not promote an unestablished goal to success. State failed or unresolved requirements plainly, mention resulting derived artifacts, and cite supported claims inline as F<number>. fact_ids must contain only currently verified IDs actually cited, supplied here or retrieved from the run ledger. Read underlying facts before citing digest references. Do not add unsupported conclusions.`,
  }[role];
  if (!roleText) throw new Error(`Unknown role: ${role}`);

  const data = {
    goal,
    ...(contract ? { contract } : {}),
    ...(task ? { task } : {}),
    ...(context ? { context } : {}),
    ...(facts ? { facts } : {}),
    ...(feedback ? { revision_feedback: feedback } : {}),
    ...(candidate ? { proposal: candidate } : {}),
    user_instructions: instructions.map(message => ({ id: message.id, text: message.text })),
  };

  return `You are an ID2A agent in an evidence-backed software workflow.
Role: ${role}
Source workspace: ${workspace}
Task directory: ${directory}
Apply the goal, assigned task, and user_instructions below; later user instructions take precedence.
Return exactly one complete JSON object matching the supplied schema.

${roleText}
${role === 'worker' && task?.resources?.workspace === 'read' ? '\nThis task holds a shared READ reservation. Do not modify the workspace or run tools that write build/cache/test outputs. If mutation is required, submit the gap for replanning with a WRITE reservation.\n' : ''}
${context?.lookup ? '\nContext is a selection: coverage reports total/included/truncated for each collection. Digests are indexes, not complete evidence. Use ledger_page with context.snapshot to enumerate omitted records and facts_get for evidence. current_evidence=false means the registered source has changed or disappeared and cannot support current completion. Prioritize unresolved work before a completion decision; absence from this prompt is not proof of absence from the ledger. On a snapshot-change error, refresh from offset 0.\n' : ''}

Assigned data (JSON):
${JSON.stringify(data, null, 2)}`;
}
