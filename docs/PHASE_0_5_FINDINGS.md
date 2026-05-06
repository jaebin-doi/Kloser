# Phase 0.5 Findings — what the spike actually showed

> Audience: future me / the Phase 1 author.
> Format: every finding has **(1) what we observed**, **(2) what it means
> for Phase 1**.

## Outcome

`docs/PHASE_0_5_LIVE_SPIKE.md` §7의 go/no-go gate **모두 통과**:

- `/health` 응답 OK
- `live.html`의 `setTimeout(appendMessage)` / `setTimeout(renderSuggestions)` = 0개
- 서버 자동 재생: 인사 → HubSpot → 가격 → 견적 흐름이 기존 데모와 동일한 타이밍
- Sentiment 관심 → 망설임 → 재고려 자동 전이
- 수동 `text_chunk` RTT **1ms** (목표 150ms 대비 여유)
- 서버 재시작 후 페이지 reload만으로 동일 동작
- 본 문서로 후속 작업 정리됨

→ **Phase 1 진입 가능.**

## 발견 사항

### 1. tsx watch는 새 파일을 자동 감지 못한다 (개발자 경험)

(1) Day 4에서 `src/fixtures/demo-call.ts`를 새로 만들고 `src/ws/calls.ts`에 import를 추가했는데, 기존 `tsx watch` 프로세스가 새 파일을 감지하지 못해 fixture 변경이 반영되지 않았다. `taskkill /F /IM node.exe` 후 `npm run dev`를 재실행해서 해결.

(2) Phase 1에서 watch 모드는 `nodemon` + `--watch src` 또는 `tsx`의 `--clear-screen=false` + 명시적 watch glob을 검토. 또는 적절히 빠른 빌드 도구 (esbuild/swc)로 교체. 어쨌든 "import 추가 → 자동 reload"가 깨진 적이 있었다는 사실을 기억할 것.

### 2. Latency badge는 자동 재생에서 표시되지 않는다 (의도된 동작이지만 UX 결정 필요)

(1) 서버 자동 재생 transcript는 `clientSentAt`이 없어서 latency badge가 `— ms`로 머문다. 수동 `text_chunk`로만 갱신된다. 디자인 의도는 "RTT는 수동 측정"이지만, 데모를 열었을 때 latency badge가 "비활성"으로 보이는 게 사용자에게 어떻게 받아들여질지는 미지수.

(2) Phase 1 옵션:
- 자동 재생에도 서버가 `serverScheduledAt`/`serverSentAt` 차이를 latency 비슷하게 노출 (혼동 위험)
- 클라가 주기적으로 ping/pong을 쳐서 latency를 채움 (가장 솔직)
- badge를 단순히 "WS 연결 상태"로 의미를 바꾸고 RTT는 dev-only console로 빼기

### 3. Socket.io 사용감

(1) ack 패턴(`emit(event, payload, callback)`)이 Promise로 감싸기 쉽고 시범 단계에서 잘 동작했다. 네임스페이스(`/calls`)도 깔끔하게 분리됨. 자동 reconnect 기본값으로 콘솔에서 끊기/재연결 별도 처리 없이 동작.

(2) 단점/주의:
- transports를 `["websocket"]`로 강제했는데, default `polling` fallback이 있으면 디버그 시 헷갈림. **Phase 1에서는 명시적으로 `["websocket"]`만 허용** 권장.
- Socket.io는 자체 프로토콜(메시지 헤더 포함)이라 프록시/방화벽 호환성에서 native ws보다 약간 무겁다. 부하 측정은 Phase 5(STT 통합)에서 다시.
- 다중 인스턴스 확장 시 `@socket.io/redis-adapter` 필요 — Phase 1 §11 확장 문서에 명시.

### 4. snake_case vs colon-case 이벤트명

(1) `BACKEND_PLAN.md` §6은 `start_call` / `text_chunk` / `end_call` (snake_case). `FASTIFY_GUIDE.md` §8 예시는 `call:start` / `call:chunk` / `call:end` (콜론). 본 spike는 BACKEND_PLAN을 따랐다.

(2) Phase 1 첫 task 중 하나로 `FASTIFY_GUIDE.md` §8 예시 갱신. 또는 두 가지 표기를 서로 다른 layer 의미로 정의(콜론은 namespace, snake_case는 within-namespace)하는 정책 문서화. 그대로 두면 신규 개발자가 어느 쪽을 따라야 할지 헷갈린다.

### 5. transcript msg.text는 `textContent`로 잡혔지만, suggestion HTML은 여전히 `innerHTML`

(1) Day 3에서 transcript bubble은 `textContent`로 전환하여 `text_chunk`가 외부 입력 통로가 된 시점의 XSS 위험을 제거. 그러나 `aiSuggestionsEl.innerHTML = ''` + `card.innerHTML = '<svg>... ${s.body}'` 경로는 그대로다. spike 동안 server fixture만 source이므로 안전하지만, **클라가 suggestion을 emit할 수 있게 되는 순간 즉시 위험.**

(2) Phase 1에서 우선 처리 (BACKEND_PLAN.md §4 보안 베이스라인에 묶어 작업):
- DOMPurify (또는 sanitize-html) 도입
- suggestion `body`/`title` 모두 sanitize 후 렌더
- icon SVG는 화이트리스트로 별도 처리
- 회귀 가드: `eslint-plugin-no-unsanitized` 추가 검토

### 6. CORS는 좁게 잡혔지만 자체 도메인 환경에서 검증 필요

(1) `STATIC_ORIGIN=http://localhost:8765` (+ `127.0.0.1`)만 허용. localhost dev 한정 정책. CORS preflight 이슈 없이 동작.

(2) Phase 1 staging/prod에서:
- 도메인 화이트리스트로 변경 (env 기반)
- credentials 정책 (HttpOnly cookie 채택 시 `credentials: true` 유지)
- Socket.io의 별도 CORS 설정과 Fastify CORS가 분리되어 있음 — 둘 다 동기화 필요 (지금 코드는 동일 origin 배열을 양쪽에 박아둠)

### 7. tsx watch 프로세스 정리 + Playwright MCP 동거

(1) 디버깅 중 `taskkill /F /IM node.exe`로 모든 Node 프로세스를 죽인 적이 있다 — 이때 Playwright MCP server도 같이 죽었고 세션 동안 복원되지 않았다. 검증을 npm 기반 `playwright`로 우회.

(2) 운영/로컬 개발 권장:
- `npm run dev`는 별도 터미널에서 (백그라운드 데몬화 X)
- 프로세스 정리는 PID 기반(`netstat -ano | findstr 3001`로 확인 후 `taskkill /PID`)
- **MCP 서버 프로세스를 죽이지 않도록 주의** — IDE/에이전트 워크플로우 영향

### 8. 재연결 동작은 검증 안 했다

(1) 시범 단계에서 서버를 죽였다 다시 띄울 때 client가 재연결하는지는 자동 검증 안 함. 수동 reload로 동일 흐름 확인했지만 Socket.io 자동 reconnect 시 진행 중이던 call 상태 복원은 미정의.

(2) Phase 1에서:
- `connect_error` / `reconnect_attempt` / `reconnect` 핸들러 추가
- Server-side에서 `start_call`이 동일 sessionId로 재호출됐을 때 catch-up transcript를 어떻게 보낼지 정책 결정 (클라가 `sinceSeq`를 주면 server가 그 이후만 재전송)

### 9. 클라이언트 타입 / 서버 타입 중복

(1) 본 spike는 의도적으로 `shared/types/`를 만들지 않았다. `server/src/ws/calls.ts`와 `platform/ws.js`(JS) 양쪽에 이벤트 모양이 별도로 박혔다. 서버 측은 TS interface, 클라 측은 JSDoc도 없는 상태.

(2) Phase 1에서:
- `shared/types/calls.ts` 도입 + `tsconfig` paths 또는 monorepo build로 양쪽이 같은 source를 참조
- 또는 zod schema를 single source of truth로 두고 양쪽이 import (`shared/schemas/calls.ts`)
- 의사결정 시점: monorepo 도구 (pnpm workspaces / turborepo / nx) 도입 여부 — 아직 패키지가 2개(server, platform/는 아직 패키지 아님)뿐이라 도입 비용이 크다면 단순 path alias로 시작 가능

## 의도하지 않게 남긴 것

- `server/src/__test_client.ts`: Day 1 검증용 throwaway. e2e가 `test/phase_0_5_e2e.mjs`로 자리잡았으므로 Phase 1 kickoff 시 삭제 권장.

## Phase 1 첫 5개 task (제안)

이 발견을 요약한 우선순위 작업.

1. `shared/types/calls.ts` (또는 `shared/schemas/`) — 타입 중복 제거 + zod 도입
2. PostgreSQL + node-pg-migrate 부트스트랩 + RLS default-deny 베이스라인
3. JWT auth 미들웨어 (Socket.io handshake에서 token 검증) + `userId` 쿼리 파라미터 폐기
4. DOMPurify 클라 도입 + suggestion body/title 모두 sanitize
5. `FASTIFY_GUIDE.md` §8의 `call:*` 콜론 표기를 snake_case로 동기화
