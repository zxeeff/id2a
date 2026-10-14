# ID2A

Codex CLI와 Claude Code를 사용하는 지속형 로컬 개발 에이전트입니다. 일반 개발 목표를 검증 가능한 작업으로 나누고, 실제 구현·테스트·수정 사이클을 목표가 달성될 때까지 이어가며 검토한 사실과 증거를 공유합니다. 기존 IDEA와 별도로 만들었습니다.

긴 첫 프롬프트, 실행 중 추가 지시, 실시간 출력, 중단 후 재개를 지원합니다. 개발 Worker는 현재 프로젝트를 직접 수정하며 파생 파일과 실행 기록은 각 run에 저장합니다. 취약점의 자율 탐색·재현·악용을 위한 워크플로는 제공하지 않습니다.

## 바로 시작

Node.js 24 이상과 로그인된 Codex CLI 또는 Claude Code가 필요합니다. 외부 npm 패키지는 필요하지 않습니다.

```powershell
# 최초 한 번: 현재 Windows 사용자 PATH에 등록
C:\id2a\install.cmd

# 새 터미널에서 작업하려는 폴더로 이동한 뒤 실행
cd C:\project
id2a doctor
id2a
```

`id2a`만 입력하면 현재 폴더에서 첫 프롬프트 입력 화면이 열립니다. `id2a start`도 같은 동작입니다. 기본 자료 폴더는 명령을 실행한 현재 폴더입니다. 별도 폴더를 사용하려면 `--workspace C:\project`를 추가하세요. 도움말은 `id2a --help`입니다.

run의 DB와 로그는 소스 폴더를 더럽히지 않도록 중앙 저장소 `C:\id2a\runs\<run-id>`에 보관됩니다. 다만 `latest`와 `list`는 기본적으로 명령을 실행한 현재 폴더와 workspace가 같은 run만 찾으므로, 프로젝트마다 독립적으로 사용할 수 있습니다.

설치는 관리자 권한 없이 사용자 PATH에 이 폴더만 추가하며, 기존 항목을 유지하고 중복 등록하지 않습니다. PowerShell 실행 정책은 설치 프로세스에서만 지정하고 전역 설정을 바꾸지 않습니다. 이미 열린 터미널에는 새 PATH가 자동 반영되지 않을 수 있습니다. 터미널 프로그램을 다시 열거나, 현재 PowerShell에서 `$env:Path += ";C:\id2a"`를 한 번 실행하세요. 전체 경로인 `C:\id2a\id2a.cmd`도 계속 사용할 수 있습니다.

Git으로 새 PC에 설치할 때는 아래 `REPOSITORY_URL`을 실제 저장소 주소로 바꾸세요. 설치 폴더는 다른 경로로 선택해도 됩니다. 기본 run 저장소는 해당 설치 폴더 아래의 `runs`입니다.

```powershell
git clone REPOSITORY_URL C:\id2a
cd C:\id2a
npm.cmd test
.\install.cmd
```

외부 npm 의존성이 없으므로 `npm install` 단계는 필요하지 않습니다. 소스·테스트·예제·설치 스크립트는 Git으로 배포하고, run DB·증거·로그·캐시·로컬 검증 결과는 `.gitignore`로 제외합니다. `.env.example`과 `.env.template`은 필요할 때 추적할 수 있습니다.

업데이트는 실행 중인 ID2A 컨트롤러를 중단한 뒤 설치 폴더에서 `git pull --ff-only`와 `npm.cmd test`를 실행하고, 원래 작업 폴더로 돌아가 필요한 run을 `id2a resume latest`로 재개합니다. 저장된 run은 설치 PC에 남으며 Git으로 전송되지 않습니다.

첫 프롬프트를 여러 줄로 붙여 넣고 마지막 줄에 `/end`를 입력하면 시작합니다. 완료될 때까지 로그가 표시되며, 같은 터미널에 추가 지시나 아래 명령을 입력할 수 있습니다.

긴 프롬프트 파일과 한 줄 명령도 사용할 수 있습니다.

```powershell
id2a --prompt-file C:\brief.txt
id2a --workspace C:\project --prompt '문서의 설치 조건과 테스트 명령을 확인해줘'
```

UTF-8 표준입력도 전체 프롬프트로 받습니다. 파일과 표준입력의 UTF-8 BOM은 제거합니다. 프롬프트를 하위 CLI의 명령행 인수로 넘기지 않으므로 긴 입력이나 따옴표·줄바꿈에 따른 명령행 길이/이스케이프 문제를 피합니다. 초기 프롬프트와 추가 지시는 각각 UTF-8 2MB까지 받습니다. 모델 자체의 컨텍스트 한도는 별도로 적용됩니다.

Windows의 PowerShell 스크립트 실행 정책을 변경할 필요가 없습니다. `id2a.cmd`를 쓰며, 하위 CLI도 npm의 `.ps1` 대신 실제 실행 파일을 직접 시작합니다.

## 두 CLI와 권한

```powershell
# Codex만 사용
C:\id2a\id2a.cmd start --provider codex --workspace C:\project

# Claude만 사용
C:\id2a\id2a.cmd start --provider claude --workspace C:\project

# Codex 작업을 Claude가 독립 검토
C:\id2a\id2a.cmd start --provider codex --review-provider claude --workspace C:\project

# 작업자에게 전체 권한 설정을 전달
C:\id2a\id2a.cmd start --provider codex --review-provider claude --yolo --workspace C:\project
```

`--permissions yolo`가 기본값입니다. Codex의 모든 역할에는 `approvalPolicy=never`와 `dangerFullAccess`를, Claude의 모든 역할에는 `--dangerously-skip-permissions`를 전달합니다. 제한 모드가 필요하면 `--permissions workspace`를 명시하세요. CLI나 호스트에서 강제로 적용하는 관리 정책은 이 설정보다 우선할 수 있습니다.

0.1 형식의 기존 run이 예전 기본값인 `workspace`로 저장돼 있으면, 권한 옵션을 별도로 지정하지 않은 `resume`에서 새 기본값인 `yolo`로 한 번 승격합니다. 제한을 유지하려면 `id2a resume latest --permissions workspace`처럼 명시하세요.

검토·기획·목표 판정·큐레이션·편집 역할은 작업자와 별도의 세션입니다. yolo 모드에서는 Git 조회와 독립 검증이 막히지 않도록 이 세션들에도 네이티브 전체 권한을 전달하되, 역할 지시상 원본을 변경하지 않습니다. 모든 역할의 동시 실행 수는 컨트롤러가 관리하고 추가 에이전트 위임은 역할 지시에서 금지합니다.

Worker는 개발 목표에 필요한 원본 파일을 직접 편집하고 테스트할 수 있습니다. 별도의 파생 텍스트 파일은 최종 JSON의 `artifacts`에 제출하면 컨트롤러가 `tasks/T번호/outputs/`에 씁니다. yolo 프로세스는 OS 수준에서 격리되지 않으므로 전용 PC나 신뢰한 프로젝트에서 사용하세요.

## 지속형 목표 루프

실행을 시작하기 전에 Contract 역할이 초기 프롬프트와 전체 추가 지시에서 목표 계약을 만듭니다. 계약은 원래 목표 전체를 보존하는 `G0`와 구체적인 결과·산출물·제약 조건으로 구성되며, 별도의 Contract Review가 원문과 대조해 누락이나 약화가 없는지 확인합니다. 계약이 승인된 뒤에만 Planner가 작업을 나눕니다. 이후 전체 지시가 추가되면 기존 계약을 덮어쓰지 않고 새 revision을 만들며, 이전 계약과 판정은 이력으로 남깁니다.

각 작업의 수정 횟수나 기술적 실패 횟수를 소진해도 곧바로 목표 달성으로 끝나지 않습니다. Goal 역할은 현재 계약의 모든 조건을 `satisfied`, `unsatisfied`, `unknown` 중 하나로 평가하고, 충족 판정마다 현재 원본과 일치하는 검증 사실 ID를 연결합니다. 미달이면 실제 workspace, 검증된 사실, 성공·실패 작업을 다시 확인해 다른 구현·수정·검증 작업을 생성합니다. 모든 조건을 충족했다고 판단한 후보도 별도의 Goal Review가 다시 검토합니다.

완료 후보를 확정하기 직전에 컨트롤러는 계약, 사실 원장, 증거 파일, 사용자 지시가 판정 시점과 같은지 CAS 방식으로 검사합니다. 그 사이 하나라도 바뀌면 결과를 저장하지 않고 새 상태에서 다시 판정합니다. 한 실행 구간의 판정·호출 한도에 도달하면 원장 체크포인트를 저장하고 같은 프로세스에서 새 실행 구간을 자동으로 시작합니다. 무진전 한도는 종료 조건이 아니라 실패한 경로를 제외하고 다른 전략을 요구하는 재계획 경계입니다.

실행 상태 `completed`와 최종 `report.md`는 `goal_outcome=achieved`가 독립 검토까지 통과했을 때만 기록됩니다. 구간 체크포인트 동안에는 `running/pending`을 유지하며 `run:last_checkpoint`와 이벤트에 원인·평가 여부·누적 횟수를 남깁니다. 정상 실행은 목표 달성 또는 사용자의 명시적 `stop` 전까지 반환하지 않습니다. 이전 v3의 `completed/not_established` 기록은 읽을 때 `suspended`로 표시하며, `resume`하면 새 연속 실행 방식으로 이어갑니다. 더 오래된 완료 run은 근거 없이 성공으로 간주하지 않고 `legacy_unknown`으로 표시합니다.

기본 `--input-policy continue`에서는 사용자 응답을 기다리지 않습니다. 범위, 기준선, 파일 집합, 우선순위, 구현 세부사항, 검증 방법처럼 되돌릴 수 있는 선택은 가장 안전하고 제한적인 합리적 기본값을 스스로 채택하고 가정으로 기록합니다. Goal이 이런 선택에 `needs_input`을 반환해도 컨트롤러가 판정을 반려하고 실질 작업을 다시 계획시킵니다. 외부 자원이 없을 때도 가능한 우회, 대체 검증, 부분 구현을 계속 찾습니다.

정말 사용자 응답을 기다리는 동작이 필요할 때만 `--input-policy wait`를 명시하세요. 이 모드에서는 외부 비밀값, 사용할 수 없는 계정·장비, 되돌릴 수 없는 작업, 또는 “승인 전 진행 금지”라는 명시적 지시가 있을 때 `waiting_input`으로 살아 있습니다. 같은 터미널이나 `id2a send latest "지시"`로 답하면 이어서 진행합니다. 어느 정책에서도 사용자가 명시적으로 `/stop`, Ctrl+C, 또는 `id2a stop`을 요청하기 전에는 미완료 상태를 정상 종료로 처리하지 않습니다.

## 실행 중 조작

| 입력 | 동작 |
|---|---|
| 그냥 추가 지시 입력 / `/note 지시` | 전체에 지시 추가. 현재 세션에 전달하고 이후 프롬프트에도 포함 |
| `/send T1 지시` | 특정 작업에 기록하고 다시 대기열에 넣어 새 결과와 검토에 반드시 반영 |
| `/file C:\instruction.txt` | 긴 추가 지시를 UTF-8 파일에서 읽음 |
| `/status` | 작업 상태 조회 |
| `/facts 검색어` | 사실 검색. 검증 상태를 함께 표시 |
| `/inspect T1` | 작업 결과와 피드백 조회 |
| `/add 새 작업` | 사용자가 직접 요청한 새 작업 추가 |
| `/pause` | 새 작업 배정 일시 정지. 진행 중인 역할은 마칠 수 있음 |
| `/resume` | 배정 재개 |
| `/stop` 또는 Ctrl+C | 진행 중인 세션을 중단하고 재개 가능한 상태로 보관 |
| `/retry T1` | 실패·거절·완료된 작업을 다시 확인. 저장된 작업 결과가 있으면 검토부터 재시도 |
| `/workers 4` | 이후 배정의 동시 작업 수 변경 |
| `/effort high` | 이후 세션의 기본 effort 변경 |
| `/effort supervisor high` | 이후 검토 세션의 effort 변경 |
| `/input-policy continue` | 사용자 선택을 기다리지 않고 가역적 결정을 자율 처리 |
| `/input-policy wait` | 정말 필요한 외부 입력에서는 `waiting_input` 허용 |

Codex의 실행 중 전체 지시는 `turn/steer`로 전달됩니다. Claude는 스트리밍 입력의 다음 대화 차례에 넣고, 그 지시를 처리한 대체 결과를 기다립니다. 특정 작업에 보낸 지시는 현재 응답의 종료 시점과 겹쳐도 빠지지 않도록 해당 작업을 다시 대기열에 넣으며, 이전 Worker 제출이나 Supervisor 판정은 작업 상태 CAS가 맞을 때만 반영합니다. `accepted`와 `queued`를 로그에 구분하여 남깁니다. 모델/effort 변경은 이미 진행 중인 턴의 설정을 바꾸지 않고 이후 세션부터 적용합니다. 이 방식은 [공식 OpenAI app-server 문서](https://learn.chatgpt.com/docs/app-server)와 [Claude 스트리밍 입력 문서](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)를 바탕으로 구현했습니다.

첫 터미널을 계속 켜두면서 다른 터미널에서도 조작할 수 있습니다.

```powershell
C:\id2a\id2a.cmd status latest
C:\id2a\id2a.cmd logs latest --follow
C:\id2a\id2a.cmd send latest '테스트 실행 여부와 문서상의 명령을 구분해서 기록해줘'
C:\id2a\id2a.cmd send latest --file C:\instruction.txt --target 1
C:\id2a\id2a.cmd add latest '설치 문서의 지원 운영체제도 확인해줘'
C:\id2a\id2a.cmd pause latest
C:\id2a\id2a.cmd continue latest
C:\id2a\id2a.cmd stop latest
C:\id2a\id2a.cmd resume latest
C:\id2a\id2a.cmd list
C:\id2a\id2a.cmd list --global
```

`latest`와 `list`는 현재 폴더의 workspace 범위가 기본입니다. 다른 폴더를 선택하려면 `--workspace C:\project`, 중앙 저장소의 모든 run을 대상으로 하려면 `--global`을 추가하세요. 출력된 run ID 또는 run 폴더의 절대 경로를 명시하면 현재 폴더와 관계없이 그 run을 선택합니다. `--runs-root`를 썼다면 이후 명령에도 같은 루트를 전달하세요. 종료된 run에 보낸 지시는 다음 `resume`에서 적용됩니다. 완료 후 범위가 늘어난 경우 `add`로 작업을 넣거나 새 run을 만드세요.

CLI 설정 문제를 해결한 뒤 실패한 검토만 다시 실행할 수 있습니다.

```powershell
C:\id2a\id2a.cmd retry latest --target 1
C:\id2a\id2a.cmd resume latest --review-provider claude
```

## 모델과 effort

새 Codex 실행의 기본 모델은 요청한 `gpt-5.6-sol`로 고정했습니다. 기본 effort는 `xhigh`, 독립 Codex Supervisor의 기본 effort는 `max`입니다. 역할별 명시 설정이 없으면 Planner·Worker·Triage·Goal·Curator·Editor는 `xhigh`를 사용합니다. Contract는 Planner 설정을, Contract Review와 Goal Review는 Supervisor 설정을 상속합니다. 새 run 기본값은 전역 Codex/Claude 설정이나 기존 run의 저장 설정을 자동으로 변경하지 않습니다.

`xhigh`는 사용자가 선택한 기본값이며 이 작업에서 effort별 품질을 비교한 벤치마크 결과는 아닙니다. [공식 OpenAI 추론 지침](https://developers.openai.com/api/docs/guides/reasoning)은 `xhigh`의 사용 예로 깊은 연구와 보안·코드 검토를 들지만, 추가 시간·사용량을 정당화하는 품질 개선을 확인하도록 안내합니다. 반복 정리 비용이 부담되면 `/effort curator medium`이나 역할별 설정으로 낮출 수 있습니다. `max`가 항상 더 낫다는 보장은 없으며, 프롬프트가 길다는 이유만으로 최고 effort가 필요한 것은 아닙니다.

[GPT-5.6 Sol 모델 문서](https://developers.openai.com/api/docs/models/gpt-5.6-sol)는 API 기본 effort를 `medium`으로 안내하지만, 이 PC의 Codex 0.162.1 모델 목록은 기본을 `low`로 표시합니다. 따라서 ID2A는 CLI 기본값에 기대지 않고 요청한 `xhigh`를 명시합니다. 실제 CLI에서 확인한 지원 목록은 `low`, `medium`, `high`, `xhigh`, `max`, `ultra`입니다. API 문서의 지원 목록과 CLI 목록은 같지 않으므로 Codex 설정은 설치된 CLI의 모델별 목록으로 검증합니다.

`--effort`와 `/effort LEVEL`은 역할별 명시 설정이 없는 역할의 기본을 바꿉니다. 새 run의 Codex Supervisor에는 `max`가 저장되므로 검토 설정은 `--review-effort` 또는 `/effort supervisor LEVEL`로 별도로 바꿉니다. `auto`는 해당 역할의 effort를 강제로 지정하지 않고 기존 CLI 설정을 따르는 옵션입니다. Claude를 기본 provider로 선택하면 모델은 Claude CLI 설정, effort는 `auto`를 따릅니다. 다른 provider로 바뀌는 역할은 원래 provider의 모델명이나 effort를 자동 상속하지 않습니다.

```powershell
# 사용자 지정 기본값: GPT-5.6 Sol, 기본 xhigh, Codex 검토 max
C:\id2a\id2a.cmd start --provider codex
# 속도·사용량을 줄일 때: 기본 medium, 검토 high
C:\id2a\id2a.cmd start --provider codex --effort medium --review-effort high
# Claude 교차 검토의 모델/effort는 Claude CLI 설정 유지
C:\id2a\id2a.cmd start --provider codex --review-provider claude
# 기존 Codex run에도 새 기본값을 적용하려면 명시적으로 지정
C:\id2a\id2a.cmd resume latest --model gpt-5.6-sol --effort xhigh --review-effort max
C:\id2a\id2a.cmd doctor --provider codex --models
```

지원하는 Codex effort는 `model/list`의 모델별 목록과 대조합니다. 목록에 나타나는 모델이 실제 계정에서 실행 가능한지는 실행 성공으로 확인해야 합니다. Claude CLI에는 `low`, `medium`, `high`, `xhigh`, `max`를 전달할 수 있으며 모델에 따른 지원 여부는 CLI가 확인합니다.

모든 역할의 모델을 하나로 고정하지 않아도 됩니다. `examples/config.json`을 복사하여 `roleSettings`의 `contract`, `contract_review`, `planner`, `worker`, `supervisor`, `triage`, `goal`, `goal_review`, `curator`, `editor`마다 `provider`, `model`, `effort`를 설정하고 `--config`로 전달하세요. `contract`의 직접 설정은 상속한 `planner` 설정보다 우선하고, `contract_review`와 `goal_review`의 직접 설정은 상속한 `supervisor` 설정보다 우선합니다. 명령행 옵션이 설정 파일보다 우선합니다. `--model`은 기본 provider의 모델이며 `--review-provider`, `--review-model`, `--review-effort`는 Supervisor와 이를 상속하는 두 독립 검토 역할의 기본값을 지정합니다.

## 사실 교환과 검증

1. Contract가 초기 프롬프트와 전체 추가 지시에서 목표 계약 후보를 만들고, 컨트롤러가 원문 전체를 나타내는 `G0` 조건을 추가합니다.
2. Contract Review가 각 조건을 원문과 대조합니다. 모든 조건이 `covered`이고 누락이 없을 때만 계약 revision을 확정합니다.
3. Planner가 승인된 목표 계약을 최대 8개 초기 작업으로 나눕니다. 선행 작업은 앞선 작업만 참조할 수 있습니다.
4. Worker가 프로젝트를 구현·수정하고 관련 테스트를 실행한 뒤 최종 JSON으로 사실, 파생 파일, 후속 작업 제안을 제출합니다.
5. 컨트롤러가 형식, 파일 경로, 존재 여부와 크기를 확인합니다. 증거 파일을 SHA-256 이름의 사본으로 보관합니다. 파일이 있다는 것만으로 주장을 검증 상태로 만들지는 않습니다.
6. Supervisor가 새 세션에서 실제 증거 내용을 확인하고 모든 제출 사실을 정확히 한 번 판정합니다.
7. 검증된 사실이 기본 컨텍스트에 포함됩니다. 같은 key/같은 주장은 중복 저장하지 않고 출처를 추가합니다. 다른 검증된 주장이 같은 key를 쓰면 충돌을 표시하고 별도 검토 작업을 만듭니다.
8. 후속 작업은 Triage가 승인해야 대기열에 들어가며 중복은 제거합니다.
9. Curator는 범위별 미처리 사실을 입력 예산에 맞춰 나누어 요약합니다. 전달 시도한 ID, 저장에 성공한 배치의 입력 ID, 실제 digest에 연결된 ID를 구분합니다. 실패한 배치는 다음 호출에서 재시도하며, digest와 성공 기록은 한 트랜잭션으로 저장합니다. 요약의 근거 사실이 반박되거나 충돌 상태가 되면 해당 요약을 컨텍스트에서 제외합니다.
10. Goal이 계약의 모든 조건을 개별 판정합니다. 미달이면 다음 작업 사이클을 만들고, 작업 실패나 수정 상한만으로 달성을 선언하지 않습니다.
11. Goal이 `achieved` 후보를 만들면 Goal Review가 같은 계약과 현재 증거를 독립적으로 검사합니다. 하나라도 거절하면 다시 작업 또는 판정 단계로 돌아갑니다.
12. Editor가 검증된 사실, 작업 이력, 목표 판정을 바탕으로 보고서 후보를 만들고, 컨트롤러가 계약·원장·증거·지시의 동일성, 미처리 작업, 후속 작업, 조건별 근거를 한 트랜잭션에서 다시 검사합니다. CAS가 통과한 `achieved` 결과만 완료로 확정하고 컨트롤러 제어권을 반환합니다. 확정 직전 작업·지시·재시도가 먼저 커밋되면 완료 상태를 다시 열고 같은 run에서 계속합니다.

사실은 `proposed`, `verified`, `refuted`, `conflicted`, `superseded` 상태를 갖습니다. 서로 다른 문구가 같은 의미라는 점을 별도의 충돌 검토에서 확인하면 대표 주장을 남기고 나머지를 `superseded`로 표시합니다. 이 경우 참인 주장을 `refuted`로 기록하지 않습니다. `verified`는 해당 증거에 대한 독립 LLM 검토를 통과했다는 뜻입니다. 수학적 증명이나 실제 프로그램 실행에 대한 보증은 아닙니다. 관찰뿐 아니라 파일 근거가 있는 `dead_end`도 같은 검토 절차를 거쳐 저장합니다.

기본 컨텍스트 선택 예산은 12,000자입니다. 사실·작업·scope·digest 배열을 JSON 문자열 크기로 제한하며, 전체 프롬프트에는 별도로 지시문과 조회 메타데이터 등이 추가됩니다. Curator에서 단일 사실이 예산보다 크면 그 사실을 누락하지 않도록 해당 배치의 예산을 늘립니다. 원본 증거는 필요한 때만 읽습니다. SQLite WAL과 FTS5를 사용하고 각 run의 원장은 독립적입니다. 다른 run의 사실을 자동으로 섞지 않습니다. 개발 과정이나 사용자 편집으로 Git 상태가 바뀌면 변경을 이벤트로 기록하고 같은 목표를 계속합니다.

Goal·Editor에도 scope 색인과 선택된 digest를 제공합니다. `coverage`의 `total`, `included`, `truncated`가 입력 누락을 표시합니다. Goal·Editor의 사실 개수는 모든 검증 사실 기준이고, Worker는 의존 작업·scope·검색으로 모은 후보 기준이며 전체 원장 사실 개수도 별도로 표시합니다. scope별 `indexed`와 `unindexed`는 현재 유효한 digest에 연결된 검증 사실과 연결되지 않은 검증 사실의 개수입니다. digest에 연결되지 않은 사실도 원장 조회에서 빠지지 않습니다. 성공한 요약 배치에 포함됐다는 기록은 내용이 모두 보존됐다는 보증이 아닙니다.

에이전트에게 제공하는 MCP 도구는 `ledger_page`, `facts_search`, `facts_get`, `facts_context`, `workspace_read`, `evidence_read`입니다. 모두 읽기 전용입니다. `ledger_page`는 키워드 없이 `facts`, `tasks`, `digests`, `scopes`를 순서대로 조회합니다. 첫 응답의 `snapshot`과 같은 collection·필터를 유지하고 `next_offset`으로 이어서 조회하며, `next_offset: null`이면 끝입니다. 각 응답에는 `as_of` 조회 시각이 있습니다. 원장 내용이 바뀌면 이전 snapshot 조회를 거부하므로, snapshot을 생략하고 offset 0부터 다시 읽어야 합니다. 과거 원장을 복원하는 기능은 아닙니다. 페이지는 최대 50개·약 12,000자를 기준으로 나누되, 첫 항목 하나가 더 크면 온전히 반환하고 `over_budget`으로 표시합니다.

Goal·Editor는 최초 프롬프트에 없었더라도 조회한 현재 검증 사실을 인용할 수 있습니다. 컨트롤러는 인용 ID가 현재 검증 집합에 속하는지 검사하고, 판단·편집 중 원장 내용이 바뀌면 결과를 확정하지 않고 다시 판정합니다. `facts_get`에 snapshot을 전달하면 같은 조회 기준을 확인할 수 있습니다. `workspace_read`는 프로젝트 안의 텍스트만 읽고, `evidence_read`는 원장에 등록된 fact ID와 SHA-256이 정확히 맞는 불변 증거만 읽습니다.

기존 run은 스키마 변경 없이 읽을 수 있습니다. 다음 실행부터 과거 `curated_ids` 완료 표시는 신뢰하지 않고, 유효한 digest의 실제 인용과 새 성공 배치 기록을 기준으로 미처리 사실을 계산합니다.

## 저장 위치와 출력

기본 저장 위치는 `C:\id2a\runs\<run ID>\`입니다.

```text
run.json                  실행 설정과 자료 폴더/Git revision
prompt.txt                초기 프롬프트 원문
plan.json                 승인된 초기 계획
ledger.sqlite             목표 계약, 작업, 사실, 증거 참조, 지시, 판정, 세션 기록
events.jsonl              컨트롤러 이벤트
artifacts/<sha256>.blob    원본 증거 사본
tasks/T1/outputs/          작업자가 제출한 파생 텍스트 파일
attempts/1/prompt.txt      역할에 실제 전달한 입력
attempts/1/schema.json     최종 출력 스키마
attempts/1/raw.jsonl       원본 CLI 프로토콜 이벤트
attempts/1/stream.jsonl    텍스트 델타와 진행 이벤트
attempts/1/result.json    해당 역할의 구조화된 결과
report.md                 달성이 확정된 최종 보고서와 증거 색인
result.json               달성이 확정된 실행 상태, 목표 결과, 계약, 조건별 판정, 작업/사실/충돌/보고서
```

`export`는 모든 사실 상태와 증거 참조를 `snapshot.json`에 내보냅니다. DB와 증거 파일을 함께 보관해야 완전한 기록이 됩니다. 원본 CLI 로그에는 작업 프롬프트와 파일 내용이 포함될 수 있습니다.

기본 동시 작업 수는 2, 한 초기 계획 또는 목표 재계획 사이클의 작업 제안 상한은 8, 수정 요청은 작업당 최대 2회, 역할 실행 시간은 최대 1,200초입니다. Goal 판정은 실행 구간당 기본 12회, 같은 조건 판정과 이미 본 근거만 반복하는 무진전은 기본 3회, 제어 단계 복구 구간은 연속 실패 5회, provider 호출 체크포인트는 실행 구간당 기본 100회입니다. 누적 호출·판정·실패 이력은 원장에 계속 남고, 각 한도에 도달하면 컨트롤러가 새 구간을 자동으로 시작합니다.

각 값은 `--workers`, `--max-tasks`, `--max-revisions`, `--timeout`, `--max-goal-rounds`, `--max-no-progress`, `--max-control-failures`, `--max-attempts` 또는 대응하는 camelCase 설정 파일 필드로 변경할 수 있습니다. queued·reviewing 작업이 남아 있으면 체크포인트 뒤 다음 구간에서 먼저 이어서 처리하고, 작업 큐가 비었을 때만 Goal이 새 작업을 제안합니다. 무진전 시 기존 verdict·fact 이력은 보존하면서 전략 세대를 바꾸고 소진된 동일 작업의 자동 재개를 막습니다. 제어 단계 오류는 제한된 지수 backoff 후 계속 재시도합니다. `resume`은 한도 연장이 아니라 명시적 stop, 프로세스 종료 또는 장애 뒤의 복구 명령입니다. 작업별 기술적 실패는 최대 2회 후 `stalled`로 남고 Goal이 다른 접근을 찾습니다. `pause`는 새 배정 중지이며, 명시적인 중단은 사용자의 `stop`입니다. 한 run에는 컨트롤러 하나만 실행할 수 있습니다.

Worker의 파생 파일은 작업당 최대 16개, 파일당 UTF-8 512KB, 합계 2MB입니다. 증거는 파일당 64MB 이하이며 해당 작업 폴더 또는 자료 폴더 안에 있어야 합니다. 디렉터리 이탈, 드라이브 경로, Windows 특수 파일명, 출력 링크를 통한 바깥 폴더 덮어쓰기를 거부합니다.

## 검증과 예제

```powershell
# 모델 호출 없는 데모
C:\id2a\id2a.cmd demo

# 실제 CLI와 문서 샘플
C:\id2a\id2a.cmd start --workspace C:\id2a\examples --prompt-file C:\id2a\examples\brief.txt --provider codex --review-provider claude

# 자동 테스트
cd C:\id2a
npm.cmd test

# 실제 로그인된 CLI의 네이티브 권한 플래그 확인(읽기 전용 git --version)
npm.cmd run smoke:permissions
```
