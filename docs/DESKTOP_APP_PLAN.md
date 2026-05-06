# 실시간 통화 보조 (PC 데스크톱 앱) — 별도 트랙

> **상태**: 보류 (Deferred). 본 트랙은 `docs/realtime-call-assistant-guide.md`를 기반으로 별도 일정에 진행.
> Kloser 백엔드 메인 트랙(`docs/BACKEND_PLAN.md`)에는 포함되지 않음.

---

## 분리 사유

`realtime-call-assistant-guide.md` 전체가 이 트랙에 해당합니다. 핵심 이유:

- **가장 큰 리스크는 백엔드가 아니라 Windows 오디오 캡처 + 30분 안정성 + 평균 지연 3초** (가이드 13·15절)
- **표준 환경(헤드셋·소프트폰·Win 버전) 파일럿이 선결 조건** (가이드 13절)
- **PC 앱 자체가 별도 제품 라인** (Electron/Tauri/.NET WPF, 자동 업데이트, 디바이스 등록, 장애 리포트)
- **백엔드 영역도 일반 SaaS와 분리됨**: STT 게이트웨이, RAG/지식베이스, 발화 단위 세그먼트, 큐 기반 후처리 — 이건 일반 CRUD와 라이프사이클이 다름

본 트랙을 메인 백엔드 계획에 섞으면 양쪽 모두 진척이 느려지므로 분리합니다.

---

## 본 트랙에 포함되는 항목

### 클라이언트
- Windows 데스크톱 앱 (Electron / Tauri / .NET WPF 중 결정)
- WASAPI loopback + 마이크 캡처
- 오디오 청크(100~300ms, 16/24kHz mono PCM/Opus) WebSocket 업로드
- 로컬 VAD, 짧은 버퍼링, 디바이스 등록, 자동 업데이트, 로그/장애 리포트

### 서버 (메인 백엔드와 별개 또는 별도 모듈)
- 실시간 스트리밍 게이트웨이 (Fastify + WebSocket 또는 별도 서비스)
- STT 처리 워커 (Clova gRPC + PCM 게이트웨이 / Deepgram WS / OpenAI Realtime — 결정 필요)
- 발화 단위 세그먼트 처리, VAD 후처리
- AI 추천 워커 (RAG, FAQ 매칭, 추천 답변)
- 통화 종료 후 요약 워커 (BullMQ 비동기)

### DB 스키마 (본 트랙 전용)
가이드 5절 기준:
- `call_sessions`
- `audio_streams`
- `transcript_segments` (+ `org_id`, `agent_id`)
- `ai_suggestions` (+ `org_id`)
- `call_summaries`
- `follow_up_tasks` (메인 `todos` 테이블과 통합 검토)
- `knowledge_bases` / `knowledge_chunks` (pgvector)
- `devices` (PC 앱 등록·검증)

### 프론트 페이지 영향
- `platform/live.html` — 본 트랙 완료 시 백엔드 연결
- `platform/calls.html` — 본 트랙의 통화 기록 데이터에 의존
- `platform/dashboard.html` — 통화 관련 KPI(오늘 통화, 응답률, 평균 통화)는 본 트랙 완료 후 표시. 그 전엔 mock 또는 hide.

---

## 의사결정 필요 항목 (착수 시점)

가이드 14절 1단계 시작 전 결정:

1. **STT 벤더**: Clova(한국어 정확도) vs Deepgram(WS 단순) vs OpenAI Realtime(통합 편의) — 실측 필요
2. **PC 앱 스택**: Electron(빠른 PoC) vs Tauri(가벼움) vs .NET WPF(Windows 네이티브 안정성)
3. **오디오 전송**: WebSocket vs WebRTC
4. **RAG 인프라**: pgvector vs 전용 벡터 DB(Pinecone/Weaviate)
5. **녹취 저장 정책**: Supabase Storage vs S3 vs 미저장 — 법무·PIPA 검토
6. **파일럿 고객사 환경 표준**: 헤드셋 모델, 소프트폰, Windows 버전

---

## 착수 조건

본 트랙은 다음 중 하나 충족 시 우선순위 재검토:
- 메인 백엔드 Phase 1~3 완료 (Customers/Team/알림이 동작)
- 파일럿 고객사 1개 이상 확보 + 표준 환경 합의
- PC 앱 개발 리소스(개발자, 디자이너) 할당

---

## 참고 문서
- `docs/realtime-call-assistant-guide.md` — 제품·아키텍처 정의 (단일 진실원)
- `docs/BACKEND_PLAN.md` — 메인 백엔드 트랙 (본 문서와 분리)
