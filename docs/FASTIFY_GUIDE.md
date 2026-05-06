# Kloser Fastify 가이드

> **목적**: Kloser 백엔드에서 Fastify가 무엇이고, 왜 Node.js + Fastify + TypeScript를 쓰는지 정리한다.  
> **결정 상태**: Phase 0.1 확정 사항. Kloser API/WebSocket/worker entry의 서버 프레임워크는 Fastify를 기준으로 한다. DB/Auth/Storage/배포는 자체 온프레미스 기준이다.

---

## 1. Fastify란?

Fastify는 Node.js 서버 프레임워크다. Express처럼 HTTP API 서버를 만들 수 있지만, 성능, 타입 친화성, 플러그인 구조, schema 기반 validation에 더 강하게 설계되어 있다.

간단히 말하면:

```text
Node.js 런타임 위에서
HTTP API, plugin, validation, logging, error handling을 체계적으로 제공하는 서버 프레임워크
```

Kloser에서는 Fastify가 다음 역할을 맡는다.

- REST API 서버
- WebSocket 통화 세션 서버
- 자체 Auth JWT/session 검증
- 권한 검사
- STT adapter 호출
- AI API 호출
- Naver/Resend/HubSpot 같은 외부 API 연동
- job enqueue
- OpenAPI 문서 생성

PostgreSQL, Redis, 파일 스토리지가 인프라라면, Fastify는 **Kloser 제품 로직이 실행되는 서버**다.

---

## 2. 왜 Kloser에 Fastify가 맞는가

### 2.1 Node.js + TypeScript와 잘 맞음

현재 프론트는 HTML/JS 기반이고, 앞으로 `shared/`에 공통 TypeScript 타입을 둘 계획이다.

Fastify를 쓰면 API request/response 타입, WebSocket event 타입, DB DTO 타입을 프론트와 서버가 공유하기 쉽다.

```text
shared/
  types.ts

platform/
  api.js 또는 추후 TS client

server/
  src/routes/*.ts
```

### 2.2 외부 API 호출 중심 작업에 적합

Kloser의 AI 작업은 대부분 자체 머신러닝 연산이 아니라 외부 API 호출이다.

- Clova STT
- Claude/OpenAI
- Naver Search
- Resend
- HubSpot
- Slack

Node.js는 I/O 동시성에 강하다. 여러 외부 API를 기다리는 작업에는 Fastify + Node.js 조합이 적합하다.

Python이 유리한 경우는 자체 ML 모델 학습/추론, 데이터 과학 파이프라인이 많은 경우다. Kloser MVP는 그런 구조가 아니라 API orchestration에 가깝다.

### 2.3 WebSocket 세션 처리에 적합

Kloser의 핵심은 실시간 통화 보조다.

필요한 흐름:

```text
client sends audio/text chunk
  -> Fastify WebSocket server
  -> STT adapter
  -> transcript event
  -> AI suggestion event
  -> client receives live update
```

Fastify는 WebSocket plugin 또는 Socket.io와 함께 사용할 수 있다. 서버 구조는 Fastify를 중심으로 두고, 실시간 통신은 별도 namespace/handler로 분리한다.

### 2.4 Schema validation이 강함

Fastify는 JSON Schema 기반 validation을 기본 철학으로 가진다.

예:

```ts
fastify.post('/customers', {
  schema: {
    body: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        email: { type: 'string' },
        company: { type: 'string' }
      }
    }
  }
}, async (request, reply) => {
  // validated body
});
```

Kloser는 고객 정보, 통화 세션, 뉴스레터, 초대, 설정 등 입력 폼이 많다. API 경계에서 validation을 강하게 두는 것이 중요하다.

### 2.5 로깅과 운영 기본기가 좋음

Fastify는 pino 기반 로깅을 기본으로 쓴다. 운영에서 request id, latency, error log를 남기기 쉽다.

Kloser에서는 특히 다음 로그가 중요하다.

- API 요청/응답 상태
- WebSocket 세션 시작/종료
- STT 지연시간
- AI 호출 지연시간
- 외부 API 실패
- 권한 거부
- job retry/failure

---

## 3. Fastify가 담당하지 않는 것

Fastify가 모든 것을 해결하는 것은 아니다.

Fastify가 직접 담당하지 않는 영역:

- DB 엔진 자체: PostgreSQL 담당
- 파일 저장소 자체: local disk 또는 MinIO 담당
- queue 저장소: Redis 담당
- 장기 실행 job queue: BullMQ/Redis 담당
- 브라우저 UI 렌더링: `platform/*.html` 담당
- 데스크톱 오디오 캡처: Electron/Tauri/WPF 앱 담당
- AI 모델 자체: Claude/OpenAI/Clova 등 외부 API 담당

Fastify는 이 요소들을 연결하고, Kloser 도메인 규칙을 적용하는 서버다.

---

## 4. Express, NestJS, FastAPI와 비교

| 항목 | Fastify | Express | NestJS | FastAPI |
|---|---|---|---|---|
| 언어 | Node.js/TS | Node.js/TS | Node.js/TS | Python |
| 초기 속도 | 빠름 | 매우 빠름 | 중간 | 빠름 |
| 구조 강제 | 중간 | 낮음 | 높음 | 중간 |
| 성능 | 높음 | 중간 | 중간~높음 | 높음 |
| 타입 친화성 | 좋음 | 낮음~중간 | 좋음 | 좋음 |
| WebSocket | 좋음 | 가능 | 좋음 | 가능 |
| 러닝커브 | 낮음~중간 | 낮음 | 중간~높음 | 낮음~중간 |
| Kloser 적합도 | 높음 | 중간 | 중간~높음 | 중간 |

### Express를 안 고른 이유

Express는 단순하고 생태계가 크지만, validation, schema, 타입, plugin 구조가 약하다. 작은 데모는 빠르지만 Kloser처럼 멀티테넌트, 권한, 외부 API, WebSocket이 섞이면 구조가 쉽게 흐트러질 수 있다.

### NestJS를 안 고른 이유

NestJS는 큰 팀과 복잡한 서비스에는 좋다. 하지만 MVP 단계에서는 모듈, provider, decorator, DI 구조가 무겁게 느껴질 수 있다. Kloser는 아직 실제 백엔드 첫 구현 단계라 Fastify가 더 가볍다.

필요하면 나중에 NestJS로 갈 수도 있지만, 지금은 Fastify로 명확한 디렉토리 규칙을 두는 편이 빠르다.

### FastAPI를 안 고른 이유

FastAPI는 좋은 Python 프레임워크다. 하지만 Kloser MVP의 AI 작업은 Python 내부 연산보다 외부 API 호출 중심이다. 프론트와 타입 공유, WebSocket 이벤트 타입 관리, JS 생태계 활용을 고려하면 Node.js/Fastify가 더 자연스럽다.

---

## 5. Kloser 서버 구조 제안

```text
server/
  package.json
  tsconfig.json
  src/
    server.ts
    app.ts
    config/
      env.ts
    plugins/
      db.ts
      auth.ts
      cors.ts
      socket.ts
    routes/
      me.ts
      customers.ts
      team.ts
      calls.ts
      dashboard.ts
      daily.ts
      newsletter.ts
      settings.ts
    services/
      customers.service.ts
      calls.service.ts
      ai.service.ts
      stt.service.ts
      notifications.service.ts
    integrations/
      clova/
      anthropic/
      openai/
      naver/
      resend/
      hubspot/
    ws/
      calls.stream.ts
      notifications.stream.ts
    jobs/
      queue.ts
      workers.ts
    db/
      pool.ts
    schemas/
      customers.schema.ts
      calls.schema.ts
    utils/
      errors.ts
      logger.ts
```

원칙:

- `routes/`: HTTP endpoint 정의
- `services/`: 비즈니스 로직
- `integrations/`: 외부 API별 adapter
- `ws/`: WebSocket event handler
- `jobs/`: BullMQ queue/worker
- `schemas/`: validation schema
- `plugins/`: Fastify plugin 등록

---

## 6. Fastify와 PostgreSQL/Auth 연결 방식

Fastify는 자체 Auth token 또는 session을 검증하고, 요청마다 현재 사용자와 조직 context를 만든다.

```text
Authorization: Bearer <access_token>
또는 HttpOnly session cookie
  -> Fastify auth plugin
  -> token/session 검증
  -> load profile/memberships
  -> request.user, request.orgs 설정
  -> route handler 실행
```

API에서는 항상 현재 조직을 명확히 선택해야 한다.

```text
GET /customers
Header: X-Org-Id: <org_id>
```

또는 단일 조직 MVP에서는 `/me`에서 default org를 내려주고 서버가 해당 org를 사용한다. Enterprise/멀티조직 가능성을 생각하면 `X-Org-Id` 방식이 더 명시적이다.

---

## 7. API 예시

고객 목록 API의 흐름:

```ts
fastify.get('/customers', {
  preHandler: [fastify.requireAuth],
  schema: {
    querystring: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        status: { type: 'string' },
        page: { type: 'number', minimum: 1 }
      }
    }
  }
}, async (request, reply) => {
  const orgId = request.org.id;
  const customers = await customerService.list(orgId, request.query);
  return { data: customers };
});
```

핵심은 route handler가 얇아야 한다는 점이다. 실제 조회/검증/도메인 로직은 service에 둔다.

---

## 8. WebSocket 예시

Live 통화 스파이크의 이벤트 구조:

```text
client -> server
  call:start
  call:chunk
  call:end

server -> client
  transcript
  suggestion
  sentiment
  checklist:update
  error
```

초기 Phase 0.5에서는 실제 오디오 대신 텍스트 chunk를 보낸다.

```json
{
  "type": "call:chunk",
  "callId": "uuid",
  "speaker": "customer",
  "text": "HubSpot 연동이 가능한가요?"
}
```

서버 응답:

```json
{
  "type": "suggestion",
  "callId": "uuid",
  "items": [
    {
      "kind": "script",
      "title": "추천 멘트",
      "body": "HubSpot은 초기에는 read-only 동기화부터 지원한다고 안내하세요."
    }
  ]
}
```

이 구조를 먼저 잡아야 실제 STT를 붙일 때도 프론트 변경이 작아진다.

---

## 9. 에러 처리 원칙

Fastify에서는 에러 포맷을 통일한다.

```json
{
  "error": {
    "code": "CUSTOMER_NOT_FOUND",
    "message": "Customer not found",
    "requestId": "req_..."
  }
}
```

원칙:

- validation error는 400
- 인증 없음은 401
- 권한 없음은 403
- 리소스 없음은 404
- 외부 API 실패는 502 또는 job retry
- 서버 버그는 500

프론트 `platform/api.js`는 이 포맷을 기준으로 toast, empty state, retry UI를 처리한다.

---

## 10. 테스트 전략

Fastify 서버 테스트는 다음 조합을 사용한다.

- unit: service 함수
- API: Fastify inject 또는 supertest
- WebSocket: 이벤트 단위 integration test
- DB: local PostgreSQL test database
- E2E: 기존 Playwright smoke test 확장

초기 필수 테스트:

- `/me` 인증 성공/실패
- `GET /customers` org 격리
- `POST /customers` validation
- viewer role write 차단
- WebSocket `call:chunk -> transcript/suggestion` 이벤트

---

## 11. 운영 관점

Fastify 운영에서 확인할 지표:

- HTTP latency p50/p95/p99
- WebSocket active connections
- 통화 세션 평균 길이
- STT adapter latency
- AI suggestion latency
- 외부 API 실패율
- job queue 대기 시간
- memory/CPU 사용량

운영 초기에는 pino 로그 + journald 또는 Docker logs로 시작하고, 이후 Sentry/Axiom/Datadog 같은 모니터링 도구를 붙인다.

---

## 12. 최종 판단

Fastify는 Kloser에서 **가볍지만 구조를 잡을 수 있는 서버 프레임워크**다. PostgreSQL/Redis/Storage가 인프라를 맡고, Fastify는 Kloser의 API, WebSocket, 외부 API orchestration, 인증/권한 검사, job enqueue를 담당한다.

현재 단계에서는 Express보다 구조가 좋고, NestJS보다 가볍고, FastAPI보다 프론트 타입 공유와 Node.js I/O 모델에 잘 맞는다. 그래서 Kloser MVP 백엔드는 Node.js + Fastify + TypeScript가 적합하다.

---

## 13. 참고 문서

- Fastify Docs: https://fastify.dev/docs/latest/
- Fastify TypeScript: https://fastify.dev/docs/latest/Reference/TypeScript/
- Fastify Validation and Serialization: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- Kloser Backend Plan: `docs/BACKEND_PLAN.md`
- Kloser Supabase vs On-Premise: `docs/SUPABASE_VS_ONPREM.md`
