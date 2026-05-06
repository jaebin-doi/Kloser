# Phase 0.5 — Live 스트림 스파이크 구축 설계

> **목적**: `BACKEND_PLAN.md` v0.4 §8 Phase 0.5의 구체 실행 계획.
> Auth/DB/STT 없이 **실시간 이벤트 파이프라인이 동작한다**는 사실만 먼저 증명한다.
>
> **기간**: 3~5일.
> **단계별로 진행**한다. 한 단계가 끝나야 다음 단계로 간다.

---

## 진행 상태 (Implementation Log)

> 이 섹션은 구현하면서 갱신된다. 각 항목 옆 체크박스 + 한 줄 메모.

- [x] Day 0 — `server/` 부트스트랩 + `/health` (Fastify 5 + TS, port 3001, health 응답 OK)
- [ ] Day 1 — Socket.io `/calls` 네임스페이스 + echo + clientSentAt round-trip
- [ ] Day 2 — `platform/ws.js` 래퍼 + socket.io-client CDN 주입
- [ ] Day 3 — `live.html` mock 제거 + textContent 전환 + async IIFE init
- [ ] Day 4 — `fixtures/demo-call.ts` + start_call 자동 재생 + 타이머 정리
- [ ] Playwright 검증 — 자동 재생 흐름 + RTT < 150ms 확인
- [ ] Day 4-5 — `server/README.md` + `PHASE_0_5_FINDINGS.md` + 체크박스 업데이트

**환경 노트**:
- Windows 11에 Python alias 미설치 → 정적 서버는 `npx http-server -p 8765`로 대체 (동작 동일: 루트 서빙). README에 두 가지 명령 모두 명시.
- 정적 서버: `http://localhost:8765` / API+WS: `http://localhost:3001`.

---

## 0. 왜 이 단계가 먼저인가

Kloser의 차별화 핵심은 "통화 중 실시간으로 응대를 도와주는 화면"이다. Auth/CRUD/대시보드는 어떤 SaaS에도 있지만, **저지연 음성→전사→AI 추천 파이프라인**이 실제로 굴러가는지가 제품 가치의 90%다.

Phase 1(Auth)부터 시작하면 안 되는 이유:

- Auth/DB가 1~2주 걸린 뒤에야 실시간 부분에 손을 대게 됨.
- 만약 실시간 파이프라인 설계에 큰 결함이 있으면, 그 시점에 Auth/DB 위에 쌓아놓은 결정이 같이 흔들림.
- "WebSocket 띄우고 텍스트 청크가 1초 안에 왕복하는가"를 먼저 확인하면, 위험을 가장 싼 비용으로 제거.

따라서 0.5는 **위험 제거용 spike**다. 이 단계의 코드 일부 또는 전부는 Phase 1에서 재작성될 수 있다는 전제 하에 진행한다.

---

## 1. 범위 (Scope) — 명시적으로 정한다

### 한다

- `server/` 디렉토리에 Fastify + TypeScript 부트스트랩
- WebSocket(`/calls` 네임스페이스) 띄우기
- 클→서버 이벤트: `start_call`, `text_chunk`, `end_call`
- 서→클 이벤트: `transcript`, `suggestion`, `sentiment`, `error`
- `platform/ws.js` 클라이언트 래퍼
- `platform/live.html`의 `setTimeout` 기반 mock을 WebSocket 이벤트 기반으로 교체
- 라운드트립 지연 측정 (text_chunk → transcript echo)

### 안 한다 (Phase 1 이후로 미룸)

- DB, 마이그레이션, ORM
- 자체 Auth, JWT 검증, RLS, 조직 분리 — 0.5에서는 fake token만 통과
- 실제 STT (Clova) — text_chunk만 다룸. audio_chunk는 Phase 5
- 실제 LLM 호출 — fixture 데이터로 suggestion 생성
- 영구 저장 — 메모리 기반 in-process state만
- 다중 클라이언트, 룸 기반 분리 — 단일 콜 단일 클라이언트만 가정
- Reverse proxy, TLS — `localhost` 평문
- BullMQ, Redis — 비동기 큐 없음
- 보안/검증 schema — 최소한만 (Phase 1에서 zod/typebox 도입)

이 경계를 흐리면 0.5가 1주를 넘는다. 흐트러질 것 같으면 멈추고 이 문서로 돌아온다.

---

## 2. 사전 결정 (스파이크 시작 전 확정)

| 항목 | 결정 | 이유 |
|---|---|---|
| WebSocket 라이브러리 | **Socket.io** | `/calls` 네임스페이스, 자동 재연결, 이벤트 기반 — spike 속도 우선. Phase 1 후반에 native `ws`로 다운그레이드 가능성 검토 가능 |
| 런타임 | Node.js 20 LTS+ | Fastify 4/5 지원 범위, ESM 안정 |
| 언어 | TypeScript | BACKEND_PLAN.md §0 결정 사항 |
| dev 실행 | `tsx watch` | 빌드 없이 즉시 재시작. 0.5에서 build 단계 불필요 |
| 패키지 매니저 | **npm** | 추가 도입 없음. Phase 1에서 pnpm/yarn 검토 가능 |
| API 포트 | `3001` | Fastify HTTP/WebSocket 전용. 5xxx/8xxx 충돌 회피 |
| 정적 HTML 서빙 | **기존 방식 유지** — 프로젝트 루트에서 `python -m http.server 8765`, 접근은 `http://localhost:8765/platform/live.html` | `test/README.md`의 스모크 테스트가 이 경로를 전제. `npx serve platform`은 `../assets/...` 상대 경로와 기존 테스트 기준을 깬다. 0.5는 **8765(정적) + 3001(API)** 두 포트로 고정 |
| CORS | `http://localhost:8765` 명시 허용 | dev 한정. 와일드카드 대신 정적 서버 origin만 허용해서 Phase 1 정책과 형태 동일 |
| Auth | placeholder `userId` 쿼리 파라미터 | wire format은 유지하되 검증은 통과 처리. Phase 1에서 JWT로 교체 |
| 이벤트 이름 규약 | **snake_case** (`start_call`, `text_chunk`, `end_call`) | `BACKEND_PLAN.md` §6이 canonical. `FASTIFY_GUIDE.md` 8절 예시(`call:start` 콜론 표기)는 v0.4 이전의 잔재로 본 spike 기준이 아님. Phase 1 정리 시점에 가이드 동기화 필요 (§6 후속 표 참고) |

미정 항목: 없음 (이 표에서 결정). 새 미정 항목이 생기면 §6 "후속 정리"에 적고 Phase 1에 위임한다.

---

## 3. 최종 구조 (5일 끝났을 때 디렉토리)

```text
kloser/
├── platform/
│   ├── live.html          # mock 제거됨, ws.js로 교체
│   ├── ws.js              # NEW — Socket.io client wrapper
│   └── ...                # (변경 없음)
├── server/                # NEW
│   ├── package.json
│   ├── tsconfig.json
│   ├── .gitignore
│   ├── README.md          # 0.5 spike 사용법
│   └── src/
│       ├── server.ts      # Fastify entry
│       ├── ws/
│       │   └── calls.ts   # /calls namespace handler
│       └── fixtures/
│           └── demo-call.ts  # live.html에서 옮긴 conversation + aiSequence
└── docs/
    └── PHASE_0_5_LIVE_SPIKE.md  # 이 문서
```

`shared/types/`는 0.5에서는 만들지 않는다. 이벤트 타입은 `server/src/ws/calls.ts`와 `platform/ws.js`에 각각 정의한다(중복). Phase 1에서 `shared/types/calls.ts`로 통합한다. 지금 통합하면 monorepo build 도구 결정까지 끌려와서 spike 흐름이 깨진다.

---

## 4. 단계별 작업 (Day 0 → Day 4)

각 단계는 **이전 단계가 정상 동작하는 것을 눈으로 확인한 뒤** 시작한다. 회귀가 보이면 다음으로 가지 않는다.

### Day 0 — `server/` 부트스트랩 (0.5일)

**목표**: Fastify가 `localhost:3001/health`에서 `{ ok: true }`를 반환한다.

**작업**:

1. `server/package.json` 생성
   - `name: "kloser-server"`, `type: "module"`, `private: true`
   - dependencies: `fastify`, `@fastify/cors`, `socket.io`
   - devDependencies: `typescript`, `tsx`, `@types/node`
   - scripts: `dev: "tsx watch src/server.ts"`, `typecheck: "tsc --noEmit"`
2. `server/tsconfig.json` 생성 (`target: ES2022`, `module: NodeNext`, `strict: true`)
3. `server/.gitignore` (`node_modules`, `dist`, `*.log`)
4. `server/src/server.ts`
   - Fastify 인스턴스 생성, `@fastify/cors` 등록 (origin: `true` for dev)
   - `GET /health` → `{ ok: true, version: "0.5-spike" }`
   - `listen({ port: 3001, host: "0.0.0.0" })`
5. 루트 `.gitignore`에 `server/node_modules` 이미 매칭되는지 확인 (이미 `node_modules/`는 매칭됨)

**완료 기준 (Day 0)**:
- `cd server && npm install && npm run dev`가 에러 없이 실행
- 다른 터미널에서 `curl http://localhost:3001/health` → `{"ok":true,"version":"0.5-spike"}`
- `npm run typecheck` 통과

**완료 후 커밋**: `Phase 0.5 day 0: bootstrap server/ Fastify TypeScript skeleton`

---

### Day 1 — Socket.io `/calls` 네임스페이스 + echo

**목표**: 브라우저 콘솔에서 socket.io-client로 접속해서 `text_chunk`를 보내면 200ms 안에 `transcript` 이벤트가 돌아온다.

**작업**:

1. `server/src/ws/calls.ts`
   - `registerCallsNamespace(io: Server)` 함수
   - `io.of("/calls")` 네임스페이스 핸들러
   - 연결 시 `userId` 쿼리 파라미터 읽기 (검증 없음, 로그만)
   - 이벤트:
     - `start_call({ customerId? })` → ack `{ callId: string }` (UUID 또는 timestamp 기반)
     - `text_chunk({ seq, text, clientSentAt })` → 같은 socket에 `transcript({ seq, text, who: "agent"|"customer", clientSentAt, serverSentAt })` 즉시 emit. **`clientSentAt`은 그대로 echo back** (RTT 계산용). who는 seq 짝/홀로 더미 결정
     - `end_call()` → ack `{ ok: true }`
   - 연결 해제 로그
2. `server/src/server.ts`에 `socket.io` 연결
   - `import { Server } from "socket.io"`
   - `const io = new Server(fastify.server, { cors: { origin: true } })`
   - `registerCallsNamespace(io)` 호출
3. 빠른 수동 테스트:
   - 브라우저에서 `https://cdn.socket.io/4.7.5/socket.io.min.js` 로드
   - 콘솔에서 `const s = io("http://localhost:3001/calls?userId=test"); s.on("transcript", console.log); s.emit("start_call", {}); s.emit("text_chunk", { seq: 1, text: "안녕하세요", clientSentAt: Date.now() });`

**완료 기준 (Day 1)**:
- 콘솔 로그에 `transcript { seq: 1, text: "안녕하세요", ... }` 확인
- 서버 로그에 `connection`, `start_call`, `text_chunk`, `disconnect` 모두 찍힘
- `Date.now() - clientSentAt` 값이 콘솔에서 로컬 기준 50ms 미만

**완료 후 커밋**: `Phase 0.5 day 1: /calls namespace with text_chunk → transcript echo`

---

### Day 2 — `platform/ws.js` 클라이언트 래퍼

**목표**: `live.html`이 직접 socket.io를 호출하지 않고 `ws.js` 단일 진입점을 통해 연결한다. 다른 페이지(`calls.html` 등)에서도 재사용 가능한 형태.

**작업**:

1. `platform/live.html`의 `<head>`에 socket.io-client CDN 스크립트 추가 (build 단계 없음)
   ```html
   <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
   <script src="ws.js"></script>
   ```
2. `platform/ws.js` (전역 `window.kloserWS` 객체로 노출 — `_shared.js` 패턴 참고)
   - `kloserWS.connectCallNamespace({ baseUrl, userId })` → socket 인스턴스 반환
   - `kloserWS.startCall(socket, payload)` → Promise (ack 기반)
   - `kloserWS.sendTextChunk(socket, { seq, text })` → `clientSentAt`을 자동 주입
   - `kloserWS.endCall(socket)`
   - `kloserWS.onTranscript(socket, cb)`, `onSuggestion`, `onSentiment`, `onError`
   - 모든 메서드는 socket 인스턴스를 외부에서 주입받음 (테스트 용이)
3. 빠른 검증: 브라우저 콘솔에서 `kloserWS.connectCallNamespace(...)` 호출 → Day 1과 동일하게 동작

**완료 기준 (Day 2)**:
- `live.html`을 열어도 기존 동작은 그대로 (아직 mock 제거 전)
- 콘솔에서 `kloserWS.*`로 동일한 echo 시나리오 재현 가능
- `ws.js` 라인 수 150줄 이하 (얇게 유지)

**완료 후 커밋**: `Phase 0.5 day 2: add platform/ws.js Socket.io client wrapper`

---

### Day 3 — `live.html` mock → WebSocket 교체

**목표**: `live.html`을 열면 자동으로 서버에 접속해서, 서버가 보내는 이벤트로 transcript와 AI suggestion이 표시된다.

**현재 mock 위치 (교체 대상)**:
- `platform/live.html:469~479` — `conversation` 배열
- `platform/live.html:482~569` — `aiSequence` 배열
- `platform/live.html:683~685` — `conversation.forEach(... setTimeout(appendMessage, msg.delay))`
- `platform/live.html:687~710` — `aiSequence.forEach(... setTimeout(renderSuggestions + sentiment))`

**작업**:

1. mock 배열 두 개를 `live.html`에서 제거하고, `server/src/fixtures/demo-call.ts`로 옮긴다 (Day 4에서 사용).
2. `setTimeout` 루프 두 개를 제거.
3. 페이지 로드 시 (현재 `live.html:461`은 classic `<script>`이므로 top-level `await` 사용 불가 — async IIFE로 감싼다):
   ```js
   // platform/live.html — 기존 <script> 블록 안
   (async () => {
     const socket = kloserWS.connectCallNamespace({
       baseUrl: "http://localhost:3001",
       userId: "demo-user",
     });
     kloserWS.onTranscript(socket, ({ who, text }) => appendMessage({ who, text }));
     kloserWS.onSuggestion(socket, (group) => renderSuggestions(group));
     kloserWS.onSentiment(socket, ({ mood, interest, stage }) =>
       updateSentiment(mood, interest, stage),
     );
     kloserWS.onError(socket, (err) => console.error("[ws]", err));

     await kloserWS.startCall(socket, { customerId: "demo-customer" });

     window.addEventListener("beforeunload", () => kloserWS.endCall(socket));
   })().catch((err) => console.error("[live] init failed", err));
   ```
   리스너를 `startCall` 전에 등록하는 순서가 중요하다 — Day 4에서 서버가 `start_call` ack 직후 발사를 시작하므로 ack 처리 사이에 첫 이벤트를 놓치지 않도록.
4. `updateSentiment(mood, interest, stage)` 함수로 라인 691~708의 인라인 mood/interest/stage 갱신을 추출.
5. **`appendMessage`의 transcript 본문 주입을 `innerHTML` → `textContent`로 교체** (§5 "XSS 처리" 1번 참고). wrapper/avatar/timestamp는 그대로 `innerHTML`로 두되, 실제 발화 텍스트가 들어가는 풍선만 별도 `<div>`로 분리해서 `el.textContent = msg.text`. suggestion 렌더는 0.5에서 손대지 않는다.
6. **Day 3 시점에서는 서버가 아직 fixture를 흘려보내지 않는다.** 화면이 빈 상태로 떠야 정상이다(transcript 영역에 "고객 발화를 기다리는 중" 같은 placeholder만).

**완료 기준 (Day 3)**:
- 페이지 로드 시 콘솔에 `connect → start_call → call_started ack` 흐름이 보인다
- transcript 영역은 비어있다 (서버가 아직 자동 발사 안 함)
- 콘솔에서 수동으로 `kloserWS.sendTextChunk(socket, { seq: 1, text: "테스트" })` 호출하면 transcript에 "테스트" 한 줄이 표시된다 (Day 1 echo가 살아있음)

**완료 후 커밋**: `Phase 0.5 day 3: replace live.html setTimeout mocks with WebSocket events`

---

### Day 4 — 서버 측 더미 시나리오 + 지연 측정

**목표**: `start_call` 한 번으로 기존 데모와 동일한 흐름이 자동 재생된다. 라운드트립 지연이 실제 측정되어 화면 또는 콘솔에 표시된다.

**작업**:

1. `server/src/fixtures/demo-call.ts`
   - `conversation: { who, text, delay }[]` (Day 3에서 옮긴 배열)
   - `aiSequence: { at, suggestions, sentiment? }[]` (sentiment 정보를 그룹에 합침: `mood`, `interest`, `stage`)
2. `server/src/ws/calls.ts`의 `start_call` 핸들러:
   - 기존 echo 동작은 유지 (수동 테스트용)
   - 추가로, 서버가 `conversation` 각 항목을 `setTimeout(emit transcript, delay)`로 자동 발사
   - `aiSequence` 각 항목을 `setTimeout(emit suggestion + emit sentiment, at)`로 발사
   - `end_call` 또는 disconnect 시 모든 timer `clearTimeout`
3. 지연 측정 (서버가 `clientSentAt`을 echo back하는 단순 방식):
   - 클라이언트가 보내는 `text_chunk`에는 `clientSentAt: Date.now()` 포함 (이미 Day 2에서 처리)
   - **서버는 `transcript` 응답에 받은 `clientSentAt`을 그대로 포함** + `serverSentAt: Date.now()`도 추가
   - 클라이언트는 수신한 이벤트의 `clientSentAt`만으로 RTT 계산: `Date.now() - event.clientSentAt`
     ```js
     kloserWS.onTranscript(socket, ({ who, text, clientSentAt }) => {
       appendMessage({ who, text });
       if (typeof clientSentAt === "number") {
         const rtt = Date.now() - clientSentAt;
         console.log("[latency] %d ms", rtt);
         document.getElementById("latencyVal")?.replaceChildren(
           document.createTextNode(`${rtt} ms`),
         );
       }
     });
     ```
   - 클라이언트에 별도의 `seq → sentAt` map은 두지 않는다 — echo 방식이 더 단순하고 메모리 누수 위험도 없음
   - 화면 우상단에 `latencyVal` 텍스트는 옵션 (30분 이내면 추가)
4. 자동 재생 흐름의 `transcript`/`suggestion`은 서버 자체 발사이므로 `clientSentAt`이 비어 있다 → RTT 측정 대상 아님 (위 코드의 `typeof === "number"` 가드가 자동으로 걸러줌). RTT는 수동 `text_chunk`로만 측정.

**완료 기준 (Day 4)**:
- `live.html`을 열면, 5초 시점부터 transcript가 자동으로 추가되기 시작 → 9초, 13.5초, ... 기존 데모와 동일한 타이밍
- 14초 시점에 첫 suggestion + sentiment("관심", 92%) 갱신
- 로컬 환경에서 수동 `text_chunk` RTT가 **150ms 이하** (BACKEND_PLAN의 1~3초는 Phase 5 STT 포함 목표; spike는 echo만이므로 훨씬 빨라야 정상)
- 서버를 죽이면 reconnect 동작 확인 (Socket.io 기본 동작)

**완료 후 커밋**: `Phase 0.5 day 4: server-driven demo replay + latency measurement`

---

### Day 4~5 — 정리 & 후속 작업 식별 (0.5일)

**작업**:

1. `server/README.md` 작성: 실행 방법, 포트, 구조, "이 코드는 Phase 1에서 재작성된다"는 경고
2. 0.5에서 발견한 이슈를 `docs/PHASE_0_5_FINDINGS.md`로 정리:
   - Socket.io 사용감 (좋았던 점, 걸린 점)
   - native `ws`로 갈만한 이유가 있었는지
   - CORS, reconnect, ack timeout 동작
   - 다중 페이지/탭에서 동시 연결 시 동작
   - Phase 1에서 가장 먼저 잡아야 할 항목 (auth 토큰 형식, multi-tenant room 키, 이벤트 schema)
3. BACKEND_PLAN.md §8 Phase 0.5 항목 체크박스 갱신

**완료 후 커밋 2개**:
- `Phase 0.5 wrap: server README and runbook`
- `Phase 0.5 findings: notes and Phase 1 follow-ups`

---

## 5. 이벤트 스키마 (0.5 한정 — Phase 1에서 zod로 굳힘)

### Client → Server

```ts
// 0.5 시점 — TypeScript 인터페이스로만 표현, 런타임 검증 없음

interface StartCallPayload {
  customerId?: string;  // 0.5에서는 무시
}

interface TextChunkPayload {
  seq: number;          // 1부터 monotonic
  text: string;
  clientSentAt: number; // Date.now()
}

interface EndCallPayload {
  // 0.5에서는 비어 있음
}
```

### Server → Client

```ts
interface TranscriptEvent {
  seq: number;
  who: "agent" | "customer";
  text: string;
  clientSentAt?: number; // text_chunk echo 시에만. 서버 자체 발사(자동 재생)일 때는 없음
  serverSentAt: number;  // 디버그용
}

interface SuggestionEvent {
  at: number; // ms since call start (디버그용)
  suggestions: Array<{
    type: "direction" | "script" | "alert" | "risk" | "next" | "kb";
    title: string;
    body: string;       // HTML 허용 (mock 호환). Phase 1에서 sanitize 정책 결정
    tone: "blue" | "cyan" | "amber" | "rose" | "emerald" | "slate";
  }>;
}

interface SentimentEvent {
  mood: "관심" | "망설임" | "재고려" | string;
  interest: number;     // 0~100
  stage: string;
}

interface ErrorEvent {
  code: string;
  message: string;
}
```

### XSS 처리 — 0.5에서 부분적으로 잡고 간다

기존 mock에는 두 군데에서 `innerHTML`로 외부 데이터가 DOM에 들어간다.

1. **transcript `msg.text`** (`platform/live.html:601~614`) — 0.5에서 `text_chunk`가 외부 입력 통로가 되므로 **수동 echo만으로도 `<img onerror=...>` 같은 페이로드가 즉시 실행 가능**. → **Day 3에서 transcript 메시지 본문은 `textContent` 기반 DOM 생성으로 교체한다.** 풍선 wrapper는 `createElement`로 만들고 `text` 부분만 별도 element에 `textContent`로 주입. 이게 0.5에서 가장 싼 방어선.
2. **suggestion `body` / `title`** — fixture에 `<b>`, `<br>` 같은 inline HTML이 박혀 있어 즉시 `textContent`로 바꾸면 데모 외관이 깨진다. 0.5에서는 그대로 둔다. **단, 서버 측 fixture만 source가 되도록** spike 동안 보장(클라가 suggestion을 보내는 경로 없음).

Phase 1 시작 시 **transcript text + suggestion title/body 전체에 sanitization (DOMPurify 또는 마크업 화이트리스트)** 를 첫 task로 잡는다 — 0.5 findings에 명시한다.

---

## 6. 위험과 미정 — 0.5 끝났을 때 Phase 1로 넘기는 것

| 항목 | 0.5에서의 처리 | Phase 1에서 결정해야 할 것 |
|---|---|---|
| Auth | placeholder `userId` 쿼리 파라미터 | JWT 발급/검증, refresh, handshake에 token 전달 위치 (header vs cookie vs auth payload) |
| 이벤트 스키마 | TS interface, 런타임 검증 없음 | zod/typebox schema, validation middleware |
| 이벤트 타입 공유 | server/와 platform/에 중복 정의 | `shared/types/calls.ts` + monorepo build 결정 |
| 다중 클라이언트 | 단일 socket 가정 | `room:org:<orgId>:call:<callId>` 키 정책, 매니저 모니터링 권한 |
| 영속성 | in-memory only | `transcripts`, `calls` 테이블 + 이벤트→DB write through |
| HTML 인젝션 — transcript text | 0.5에서 `textContent`로 잡음 | (해결됨, Phase 1에서 회귀 가드 — eslint-plugin-no-unsanitized 등) |
| HTML 인젝션 — suggestion title/body | 허용 (fixture만 source) | DOMPurify 또는 마크업 화이트리스트 강제. 클라 입력 경로가 생기기 전에 도입 |
| 이벤트 이름 정합성 | spike는 `BACKEND_PLAN.md` snake_case 기준 | `FASTIFY_GUIDE.md` 8절의 `call:start` / `call:chunk` / `call:end` 콜론 표기를 snake_case로 통일 (또는 두 형태 공존 정책 명시) |
| 재연결 동작 | Socket.io 기본값 | call resumption — 끊어진 사이의 transcript 어떻게 catch up |
| 부하/스케일 | 1 프로세스 1 콜만 | sticky session, Redis adapter, horizontal scale |

---

## 7. 완료 기준 (Phase 0.5 전체 — go/no-go gate)

다음을 모두 만족하면 0.5 종료, Phase 1 (Auth + DB) 착수.

- [ ] `npm run dev`로 서버가 뜨고 `/health`가 응답
- [ ] `live.html`에 `setTimeout(appendMessage)` / `setTimeout(renderSuggestions)`가 0개
- [ ] `live.html` 로드 → 자동으로 기존 데모와 동일한 흐름(인사 → HubSpot → 가격 → 견적)이 재생됨
- [ ] sentiment(`관심` → `망설임` → `재고려`)가 같은 타이밍에 갱신
- [ ] 수동 `text_chunk` 라운드트립 < 150ms (로컬)
- [ ] 서버 재시작 후 페이지 reload만으로 동일 동작 (재연결 의존 X)
- [ ] `docs/PHASE_0_5_FINDINGS.md`에 Phase 1 후속 항목 정리됨

하나라도 실패하면 0.5에 머문다. Phase 1로 넘어가지 않는다.

---

## 8. 한 줄 요약

> **3~5일 동안, Auth/DB는 무시하고, 텍스트 청크가 브라우저↔서버를 왕복해서 화면을 그리는지만 본다.**
> 모든 결정은 "이게 spike의 위험을 빨리 제거하는가"로만 판단한다.
