# Supabase vs 자체 온프레미스 구현 비교

> **목적**: Kloser 백엔드 인프라 선택을 기록한다.  
> **현재 결정**: Supabase managed를 쓰지 않고, **자체 서버 온프레미스**로 구현한다.

---

## 1. 결론

Kloser는 자체 서버를 보유하고 있고, 배포도 자체 서버에서 진행한다. 또한 클라우드 사용량 과금이 리스크이며, 개발 속도를 최우선으로 두지 않는다.

따라서 기본 선택은 다음이다.

```text
Fastify + TypeScript
직접 운영 PostgreSQL
자체 Auth 또는 추후 Keycloak
로컬 파일 스토리지 또는 MinIO
Redis + BullMQ
Nginx/Caddy
온프레미스 배포
```

Supabase managed는 현재 조건에서 기본 선택이 아니다.

---

## 2. 비교 대상

### A. Supabase managed

```text
Fastify API / WebSocket / Worker
  + Supabase PostgreSQL
  + Supabase Auth
  + Supabase Storage
  + Supabase RLS
```

DB/Auth/Storage를 Supabase 클라우드에서 사용한다.

### B. Self-hosted Supabase

```text
Fastify API / WebSocket / Worker
  + 자체 서버에 Supabase stack 배포
  + Supabase Auth / Storage / Studio
  + PostgreSQL
```

Supabase 생태계를 자체 서버에 올린다.

### C. Plain on-prem 직접 구성

```text
Fastify API / WebSocket / Worker
  + 직접 운영 PostgreSQL
  + 자체 Auth 또는 Keycloak
  + 로컬 스토리지 / MinIO
  + Redis + BullMQ
  + Nginx/Caddy
```

필요한 구성요소만 직접 조합한다.

---

## 3. 비교 요약

| 항목 | Supabase managed | Self-hosted Supabase | Plain on-prem |
|---|---:|---:|---:|
| 초기 개발 속도 | 높음 | 중간 | 중간 |
| 클라우드 비용 통제 | 낮음 | 높음 | 높음 |
| 자체 서버 활용 | 낮음 | 높음 | 높음 |
| 운영 단순성 | 높음 | 낮음 | 중간 |
| 구성요소 복잡도 | 낮음 | 높음 | 낮음~중간 |
| Auth 기본 기능 | 높음 | 높음 | 직접 구현 필요 |
| DB 통제 | 중간 | 높음 | 높음 |
| Storage 통제 | 중간 | 높음 | 높음 |
| 엔터프라이즈 내부망 대응 | 낮음 | 높음 | 높음 |
| 벤더 의존성 | 중간 | 중간 | 낮음 |

현재 Kloser 조건에서는 **Plain on-prem 직접 구성**이 가장 맞다.

---

## 4. Supabase managed를 쓰지 않는 이유

### 4.1 클라우드 비용이 리스크

Supabase managed는 compute, database, storage, egress 등 사용량 기반 비용이 발생한다. Kloser는 통화 전사, 녹취, 뉴스레터, AI 이벤트 로그처럼 데이터가 빠르게 늘 수 있다.

자체 서버 비용이 이미 고정비로 존재한다면 managed 클라우드 비용을 추가하는 장점이 약하다.

### 4.2 자체 서버 배포가 전제

이미 자체 서버에서 운영할 계획이라면 DB/Auth/Storage만 외부 managed로 빼는 구조가 애매해진다.

실시간 통화 백엔드는 어차피 자체 Fastify 서버가 필요하다. 그러면 PostgreSQL, Redis, Storage도 같은 운영 경계 안에 두는 편이 단순하다.

### 4.3 개발 속도가 최우선이 아님

Supabase managed의 가장 큰 장점은 속도다. 하지만 Kloser가 개발 속도보다 비용 통제와 데이터 통제를 더 중요하게 보면 이 장점은 결정적이지 않다.

---

## 5. Self-hosted Supabase를 기본값으로 두지 않는 이유

Self-hosted Supabase는 가능하다. 하지만 기본값으로는 추천하지 않는다.

장점:

- Supabase Auth/Storage/Studio를 자체 서버에서 사용 가능
- PostgreSQL 기반이라 데이터 모델이 자연스러움
- managed 비용을 피할 수 있음

단점:

- 구성요소가 많다.
- 운영/업그레이드 부담이 있다.
- Kloser가 당장 필요하지 않은 PostgREST/Realtime/Studio 구성까지 떠안게 된다.
- 단순 PostgreSQL + Fastify + Auth보다 장애 표면이 넓다.

따라서 self-hosted Supabase는 Auth/Storage/Studio 생산성이 꼭 필요하다고 판단될 때만 다시 검토한다.

---

## 6. Plain on-prem 직접 구성의 장점

- 비용 예측이 쉽다.
- 고객 정보, 통화 전사, 녹취 파일을 자체 서버 안에 둘 수 있다.
- 필요한 구성요소만 운영하므로 구조가 단순하다.
- 고객사가 내부망, 전용 서버, 데이터 외부 반출 금지를 요구할 때 대응하기 좋다.

단점도 있다.

- Auth, password reset, email verification, refresh token rotation을 직접 구현해야 한다.
- 파일 접근 권한과 backup/restore를 직접 운영해야 한다.
- DB migration, monitoring, log rotation, 보안 패치를 직접 책임져야 한다.

그래도 현재 Kloser 조건에서는 이 부담을 감수할 가치가 있다.

---

## 7. 권장 구현안

```text
Runtime: Node.js
Framework: Fastify + TypeScript
DB: PostgreSQL 16+
Migration: node-pg-migrate
Auth: 자체 Auth, Argon2id + JWT + refresh token rotation
Queue: Redis + BullMQ
Storage: local disk first, MinIO when recording storage expands
Proxy: Nginx or Caddy
Deploy: Docker Compose first, systemd optional
```

Keycloak은 초기부터 넣지 않는다. Enterprise SSO/SAML 요구가 실제로 생기면 도입한다.

---

## 8. Supabase를 다시 검토할 조건

Supabase self-hosted는 다음 조건이면 다시 검토한다.

- 자체 Auth 구현 부담이 과도함
- 관리 UI가 꼭 필요함
- Storage policy를 직접 만들기 어렵다고 판단
- 팀이 Supabase 운영 경험이 있음
- PostgREST/Realtime 같은 구성요소가 실제로 필요함

Supabase managed는 다음 조건일 때만 재검토한다.

- 자체 서버 운영을 포기
- 개발 속도가 최우선으로 변경
- 클라우드 비용 리스크가 낮아짐
- 외부 managed DB 사용이 고객/운영 정책상 허용됨

---

## 9. 최종 판단

현재 Kloser는 Supabase managed보다 자체 온프레미스가 맞다.

Supabase의 장점은 빠른 Auth/DB/Storage 구축이다. 하지만 Kloser는 자체 서버를 보유하고 있고, 비용 통제와 데이터 통제가 더 중요하다. 따라서 Fastify + PostgreSQL + 자체 Auth + Redis + 자체 Storage로 구현한다.

관련 구현 계획은 `docs/plan/BACKEND_PLAN.md` v0.4를 따른다.

