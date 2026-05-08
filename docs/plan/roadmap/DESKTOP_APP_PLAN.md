# PC 데스크톱 앱 트랙 — 보류

> **상태**: 보류 (Deferred). 본 트랙은 `docs/product/realtime-call-assistant-guide.md` 4절·13절을 기반으로 별도 일정에 진행.
> 통화 백엔드(WebSocket 세션·이벤트 스키마·STT 어댑터·`live.html`/`calls.html` 백엔드)는 메인 트랙(`docs/plan/roadmap/BACKEND_PLAN.md` Phase 0.5/4/5)에 포함됨. 본 문서는 **PC 앱 자체**에만 집중.

---

## 분리 사유

`realtime-call-assistant-guide.md` 13절: "가장 큰 리스크는 모델 성능보다 오디오 수집 안정성이다." 이건 다음 항목들에서 발생:

- 고객사 PC마다 오디오 장치 구성이 다름
- 소프트폰 앱이 오디오 캡처를 제한할 수 있음
- 마이크와 시스템 오디오 분리
- 네트워크 품질로 인한 실시간성 저하
- Windows 환경 표준화 (헤드셋·소프트폰·OS 버전)

이 리스크들은 **백엔드 작업과 라이프사이클이 다름** — 파일럿 고객사 확보, 표준 장비 합의, Windows 네이티브 모듈 디버깅이 필요. 메인 백엔드 진척과 섞으면 양쪽 모두 느려지므로 분리.

> **메인 백엔드는 PC 앱 없이도 진행 가능**: Phase 0.5 spike는 텍스트 청크로, Phase 5 실 STT는 브라우저 `MediaRecorder` 또는 테스트 오디오 파일을 임시 소스로 검증 가능. PC 앱은 production 단계의 오디오 소스 중 하나.

---

## 본 트랙 범위

### 클라이언트 (PC 앱)
- Windows 데스크톱 앱 — Electron / Tauri / .NET WPF 중 결정
- WASAPI loopback + 마이크 캡처
- 통화 시작/종료 감지 또는 수동 버튼
- 오디오 청크(100~300ms, 16/24kHz mono PCM/Opus) WebSocket 업로드
- 로컬 VAD, 짧은 버퍼링 (네트워크 끊김 대비)
- 사용자 로그인 + 디바이스 등록
- 자동 업데이트, 로그/장애 리포트, 전송 상태 표시

### 인터페이스 (메인 백엔드와의 계약)
- `BACKEND_PLAN.md` 섹션 6 "Live WebSocket" 이벤트 그대로 따름:
  - C→S `start_call`, `audio_chunk` (Phase 5), `text_chunk` (0.5 spike), `end_call`
  - S→C `transcript`, `suggestion`, `sentiment`, `checklist_update`, `error`
- 인증: 자체 Auth JWT (`BACKEND_PLAN.md` 3.2). PC 앱이 자체 로그인 화면 → `POST /auth/login`으로 access/refresh token 발급 → WebSocket handshake 시 token 전달
- 본 트랙은 메인 백엔드의 `/calls` 네임스페이스에 클라로 접속

### 파일럿 환경 표준화
- 상담원 3~5명
- 동일 헤드셋 (모델 결정 필요)
- 동일 소프트폰 (모델 결정 필요)
- 동일 Windows 버전
- 하루 20~50콜
- 저장/전송 동의 절차 완료

---

## 의사결정 필요 항목 (착수 시점)

1. **PC 앱 스택**: Electron(빠른 PoC) vs Tauri(가벼움) vs .NET WPF(Windows 네이티브 안정성)
2. **오디오 전송**: WebSocket vs WebRTC (저지연 양방향이 필요하면 WebRTC 검토)
3. **자동 업데이트**: Squirrel(Electron) / Tauri Updater / MSI + 자체 채널
4. **디바이스 등록 정책**: 디바이스당 1 user vs user당 N 디바이스
5. **녹취 저장 정책**: 로컬 디스크 / MinIO / 미저장 — PIPA·법무 검토 (`BACKEND_PLAN.md` 3.3 정합)
6. **파일럿 표준 장비**: 헤드셋·소프트폰 모델

---

## 착수 조건

다음 중 둘 이상 충족 시 우선순위 재검토:
- 메인 백엔드 Phase 5 (실 STT) 완료 — 브라우저 MediaRecorder 기반 데모로 STT 파이프라인 검증됨
- 파일럿 고객사 1개 이상 확보 + 표준 환경 합의
- PC 앱 개발 리소스 할당

---

## 참고 문서
- `docs/product/realtime-call-assistant-guide.md` — 제품·아키텍처 정의 (단일 진실원, 4절·13절·14절 1~2단계가 본 트랙)
- `docs/plan/roadmap/BACKEND_PLAN.md` — 메인 백엔드 트랙 (섹션 6 "Live WebSocket" 이벤트 = 본 트랙과의 계약)
