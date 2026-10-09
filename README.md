# Time Less Auto 2.0.0

유튜브 쇼츠용 **Project Auto-Builder**이자 완전 자동 제어탑입니다. `무인도` 같은 키워드 하나만 넣으면 새 ChatGPT 설계 탭을 열고, 웹 AI가 역할·role guidance·장면·예상 턴·최대 턴·감정 아크·종료조건을 만든 뒤 역할 수만큼 새 ChatGPT 탭을 열어 대화·실제 캡처·ZIP까지 진행합니다.

## V2 한 번의 흐름

`키워드 입력 → 설계 ChatGPT 탭 자동 생성 → 웹 AI 계획 검증/보정 → 역할 ChatGPT 탭 자동 생성 → 역할 패킷 주입 확인 → AI 턴 → 실제 응답 카드 PNG → ZIP`

1. Side Panel의 **자동 설계·실행**에서 프로젝트 한 단어 또는 설명만 입력합니다. 기존 프로젝트가 있으면 교체 확인을 한 번 받습니다. 자동 모드는 planner 선택, 사전 탭 열기, 역할 카드 연결이 필요 없습니다.
   새 설계 ChatGPT 탭 하나가 먼저 열리고, 설계 AI가 2~6개 역할 수를 선택합니다. 그 수만큼 새 ChatGPT 역할 탭이 추가로 열리며 planner 탭과 역할 탭은 분리됩니다. 참가자 카드의 **개수·순서·역할·role guidance가 실행 계약**입니다.
2. V2는 웹 요청 전에 완전한 local skeleton을 저장합니다. 웹 AI가 정확한 `TLA_PLAN_V2_BEGIN/END` JSON을 주지 않으면 두 번 보정한 뒤 이 완전한 fallback을 사용합니다. 부분 계획은 실행하지 않습니다.
   기존 수동 Project Auto-Builder 흐름은 `explicit approval` 게이트를 그대로 유지합니다.
3. 검증된 계획은 `planHash`와 request nonce를 갖습니다. 각 참가자는 `[TLA ROLE PACKET]`과 현재 `Scene Contract`를 일반 사용자 composer 메시지로 받고, 실제 DOM 카드가 확인되어야만 주입 성공으로 기록됩니다. AI가 지정한 장면별 캐스트는 그대로 유지되고, 캐스트가 비어 있는 장면만 등록된 역할 슬롯으로 채웁니다. 예전 참가자 카드는 새 역할로 자동 편입되지 않습니다.
4. 한 개의 실제 provider 응답 카드가 한 턴입니다. 응답 서명·assistant 노드 ID·카드 영역을 모두 확인한 뒤 debugger의 `Page.captureScreenshot`으로 응답 본문만 PNG로 저장하고, 하나라도 확인되지 않으면 전체 화면 대체 캡처 없이 재시도합니다. 성공 확인 전에는 다음 AI를 부르지 않습니다.
5. 장면 목표 턴 또는 최대 턴에 도달하면 `SCENE_TRANSITION` 기록을 남기고 다음 장면 패킷을 주입합니다. 전환 카드는 가짜 AI 응답이나 캡처 대상이 아닙니다.
6. 마지막 검증 PNG와 정규화 계획, `run-report.json`, `checksums.sha256`를 원자적으로 ZIP으로 만들고 Side Panel에 파일 수·크기·체크섬·예상/최대/실제 턴을 표시합니다.

## Side Panel 제어탑

`V2 · CONTROL TOWER`에 계획 단계, plan hash, 각 provider의 역할/장면/주입 상태, 이벤트 스트림, 캡처 수, ZIP 수가 실시간으로 나타납니다. **일시정지**, **계속하기**, **긴급 중지**, **초기화**, 실패/재연결 상태를 확인할 수 있습니다. 일시정지는 저장된 단계부터 재개하고, 긴급 중지도 명시적으로 **계속하기** 또는 **초기화**를 선택할 수 있습니다. 초기화하면 검증된 캡처와 현재 계획을 정리해 새 설계를 시작합니다. 원본 대화 기록을 별도 텍스트 파일로 복제하지 않고 provider 탭의 실제 기록과 화면 카드만 사용합니다.

Side Panel은 `설계 → 진행 → 결과` 세 단계로 단순화되어 현재 해야 할 한 가지 행동을 상단에 보여줍니다. 역할·AI 탭, 장면 미리보기, 대화·캡처, ZIP은 각 단계 안에 남아 있고, 턴 수·간격·재시도·Loop Guard·세부 이벤트 같은 고급 기능은 **설정·복구**와 **세부 기록**을 펼치면 사용할 수 있습니다. 자동화 상태가 바뀌면 상단 안내와 강조 카드가 함께 바뀌며, 실패 시 저장된 단계 재시도 버튼이 바로 나타납니다.

## 기존 모드 보존

- **Interactive**: 사용자가 composer로 다음 말을 넣는 직접 진행입니다.
- **Full Auto**: AI끼리 이어지는 자동 진행입니다. 기존 `Pause` 후 `Join conversation` 흐름도 유지됩니다.
- 역할 입력, session template, Loop Guard, background-tab operation, pause/resume/end, bounded capture retries를 그대로 유지합니다.
- `End`는 새 계획을 만들기 전 현재 run을 닫습니다. strict isolation이 필요하면 Side Panel의 **AI 탭 열기**로 `fresh provider` 대화 탭을 만드세요. 기본값은 provider별 **새 대화 탭**이며, 기존 `provider history` 탭 재사용은 명시적으로 선택한 경우에만 허용됩니다.
- 관찰자 제어는 Side Panel의 pause/resume/stop만 사용합니다. provider의 prompt-level 지시는 역할 패킷과 Scene Contract 안에만 포함되며, 기존 대화를 몰래 수정하지 않습니다. 실제 user-composer 경로로만 메시지를 보냅니다. V2 AI 답변 원문은 세션 라우팅에만 쓰고, 패널·영구 저장·ZIP에는 실제 응답 카드 PNG와 캡처 메타데이터만 남깁니다.

## YouTube 전용 범위

이 버전은 YouTube Shorts용 대화와 **실제 AI 응답 본문 카드** 캡처에 집중합니다. OCR, 글자 재생성, generated replacement image, 전체 브라우저 캡처를 쓰지 않습니다. assistant 응답으로 확인되지 않은 PNG는 ZIP에 포함하지 않습니다. MP4 렌더링, 자막, 음악, 업로드, 매일 예약 실행, 조회수 보장은 포함하지 않습니다.

## ZIP 구성

```text
manifest.json          # schemaVersion, normalized plan, planHash, bindings
run-report.json        # 상태 이벤트, 재시도, 실패, 턴/캡처/ZIP 수
checksums.sha256       # 모든 manifest/report/screenshot member의 SHA-256
screenshots/*.png      # verified actual response-card PNG only
```

## 설치

1. `time-less-auto-v2.0.0-installable.zip`을 원하는 폴더에 압축 해제합니다. **ZIP 파일 자체를 로드하지 마세요.**
2. Chrome에서 `chrome://extensions` → **개발자 모드** → **압축해제된 확장 프로그램을 로드**를 선택하고, `manifest.json`이 바로 들어 있는 폴더를 고릅니다. 준비된 폴더는 `time-less-auto-v2.0.0-installable`입니다.
3. ChatGPT에 로그인한 상태에서 Side Panel에 `무인도` 입력 → **자동 설계·실행**을 누르면 됩니다. V2가 설계 탭과 역할 탭을 모두 만들고, 설계 응답이 없으면 완전한 로컬 계획으로 이어서 실행하며 캡처 ZIP은 Chrome Downloads에 저장합니다.
4. 기존 provider 탭을 직접 쓰고 싶을 때만 **직접 탭 연결 (선택)**을 펼쳐 수동 planner와 역할 바인딩을 사용합니다. 자동 모드는 기존 탭을 닫거나 내용을 지우지 않습니다.

## V2가 대기에서 멈출 때

- 확장 프로그램에서 **새로고침**을 누른 뒤, 이미 열려 있던 ChatGPT·Claude·Gemini·Copilot 탭도 각각 `Ctrl+R`로 새로고침합니다. 이전 Lee Relay 런타임이 남아 있으면 V2가 그 탭을 사용하지 않습니다.
- 이전 실행이 남아 있으면 **초기화**를 누르고 새로 시작합니다. `PLAN_REQUESTED` 단계는 새로고침 후 저장된 설계 예약이 다시 실행됩니다.
- 자동 모드에서는 설계 AI와 역할 AI 탭을 직접 열 필요가 없습니다. 실행 중 닫힌 역할 탭만 새로 열어 복구하며, 기존 unrelated 탭은 재사용하지 않습니다.
- 이제 V2 런타임이 없으면 조용히 진행하지 않고 Side Panel에 원인을 표시합니다. 표시된 AI 탭을 새로고침한 뒤 **계속하기**를 누르세요.

응답 카드 영역을 정확히 저장하려면 Chrome `debugger` 권한이 필요합니다. 확장 프로그램은 AI 계정에 로그인하거나 provider 기록을 자동 삭제하지 않습니다.

## 지원 provider

ChatGPT (`chatgpt.com`, `chat.openai.com`), Claude (`claude.ai`), Gemini (`gemini.google.com`), Copilot (`copilot.microsoft.com`).

## 브랜드 자산

`logo-master.png`는 투명 원본이고, `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`는 동일 로고의 크기별 버전입니다.
