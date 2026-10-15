import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, createRun } from './engine.mjs';
import { readText } from './util.mjs';

// Deterministic local demonstration, explicitly separate from real model validation.
export async function demo(root, onEvent) {
  const workspace = fileURLToPath(new URL('../examples/', import.meta.url));
  const directory = createRun({ workspace, workers: 1 }, '문서의 Node.js 버전을 확인하세요. 작업 하나만 수행하세요.', root);
  const providerFactory = (_name, options) => ({
    done: false,
    async steer() { return 'pending'; },
    async run({ prompt }) {
      const role = /^Role: (\w+)/mu.exec(prompt)[1];
      const data = JSON.parse(prompt.split('Assigned data (JSON):\n')[1]);
      options.onSession?.('demo-' + role);
      if (role === 'contract') return { objective: '문서의 Node.js 최소 버전을 확인한다.', requirements: [{
        type: 'outcome', statement: '문서에 명시된 Node.js 버전을 확인한다.', source_reference: '문서의 Node.js 버전을 확인하세요.', verification: '원본 문서의 버전 문구를 현재 증거로 확인한다.',
      }] };
      if (role === 'contract_review') return { decision: 'accept', reason: '원래 요청을 그대로 보존합니다.', missing_requirements: [],
        requirement_reviews: data.proposal.requirements.map(item => ({ requirement_id: item.id, verdict: 'covered', reason: '요청에 직접 대응합니다.' })) };
      if (role === 'planner' && data.context?.operation === 'rolling_refill') return {
        status: 'EXHAUSTED', summary: 'Current task covers the goal.', tasks: [], wake: { kind: 'none', task_ids: [] },
      };
      if (role === 'planner') return { summary: '문서의 실행 환경 확인', tasks: [{ title: 'Node.js 버전 확인', brief: 'sample-notes.txt에서 Node.js 최소 버전을 확인하세요.', scope: 'docs.runtime', depends_on: [] }] };
      if (role === 'worker') return { summary: '문서에 Node.js 24 이상이라고 명시되어 있습니다.', artifacts: [{ path: 'summary.txt', content: '문서에서 확인한 실행 환경: Node.js 24 이상\n' }], facts: [{ key: 'docs.runtime.node', scope: 'docs.runtime', kind: 'observation', claim: '문서는 Node.js 24 이상을 요구합니다.', evidence: [{ path: path.join(workspace, 'sample-notes.txt'), note: '두 번째 줄' }] }], followups: [] };
      if (role === 'supervisor') {
        const supported = readText(data.facts[0].evidence[0].artifact).includes('Node.js 24');
        return { decision: supported ? 'accept' : 'reject', reason: '원본 증거의 Node.js 버전과 일치', fact_verdicts: data.facts.map(fact => ({ id: fact.id, state: supported ? 'verified' : 'refuted', reason: '실제 파일 내용 확인' })) };
      }
      if (role === 'goal') return { decision: 'achieved', contract_revision: data.contract.revision,
        requirement_evaluations: data.contract.requirements.map(item => ({ requirement_id: item.id, verdict: 'satisfied', fact_ids: data.facts.map(fact => fact.id), reason: '원본 문서 증거가 조건을 충족합니다.' })),
        reason: '요청한 문서 확인과 독립 검토가 끝났습니다.', progress: 'Node.js 최소 버전을 실제 문서에서 확인했습니다.', next_tasks: [], question: '' };
      if (role === 'goal_review') return { decision: 'accept', contract_revision: data.contract.revision, reason: '모든 조건이 현재 증거로 확인됩니다.',
        requirement_reviews: data.contract.requirements.map(item => ({ requirement_id: item.id, verdict: 'accept', reason: '인용된 문서 증거가 관련 조건을 직접 뒷받침합니다.' })) };
      if (role === 'curator') return { scope: 'docs.runtime', summary: '문서 기준 실행 환경은 Node.js 24 이상입니다.', fact_ids: data.facts.map(fact => fact.id) };
      if (role === 'editor') return { title: '로컬 데모 결과 (LLM 호출 없음)', body: '문서에는 Node.js 24 이상을 요구한다고 적혀 있습니다. [F1]', fact_ids: data.facts.map(fact => fact.id) };
      throw new Error('예상하지 않은 demo role');
    },
  });
  console.log(`데모: LLM 호출 없이 전체 원장 흐름을 검사합니다.\nRun: ${directory}`);
  const engine = new Engine(directory, { onEvent, providerFactory });
  try { return await engine.run(); } finally { engine.close(); }
}
