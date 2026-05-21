# Phase 9 Runbook — Local Dev Pilot

작성일: 2026-05-21

상위 문서: `PHASE_9_MASTER.md`, `PHASE_9_STEP_7_PLAN.md`
관련 결과: `PHASE_9_STEP_5_FINDINGS.md`, `PHASE_9_STEP_6_FINDINGS.md`

> 본 runbook은 **로컬 dev pilot**용이다. real S3/MinIO, real Azure Speech, production installer는 포함하지 않는다. clean Windows 머신에서 본 절차만 보고 server → static frontend → WPF desktop을 띄우고 calls.html에서 통화 결과(전사 + 녹취 재생)를 확인할 수 있어야 한다.

---

## 0. 사전 준비

필수:

- Windows 10/11 + .NET SDK 8.0.421 이상 (`C:\Program Files\dotnet\dotnet.exe`).
- Node.js 20+ (`npm` 사용).
- Docker Desktop (PostgreSQL 컨테이너용).
- Python 3.x (static frontend 서빙용 `python -m http.server`).
- 활성화된 마이크 + 시스템 오디오 출력 장치.

권장:

- 별도 모니터/스피커 + USB 또는 빌트인 마이크.
- 5분 baseline 시나리오 (S6) 검증용으로 실 통화 시나리오 또는 재생 가능한 오디오 소스 (YouTube, mp3).

검증 안 한 환경:

- WSL2 안에서 desktop 실행 — WPF + WASAPI라 정상 동작 보장 안 됨. 호스트 Windows에서 실행.
- 헤드리스 / RDP 세션 — 오디오 endpoint 없거나 가상 endpoint라 capture 실패 가능.

---

## 1. 실행 순서

순서대로 4개 터미널을 띄운다. 첫 3개는 백그라운드로 유지하고, 마지막 WPF 터미널은 실 사용자 조작용.

### 1.1 PostgreSQL (Docker)

```powershell
docker compose -f ops/docker-compose.yml up -d
```

확인:

```powershell
docker compose -f ops/docker-compose.yml ps
```

`postgres` 컨테이너가 `Up`이어야 한다.

### 1.2 server/.env (로컬 dev 예시)

리포지토리는 `server/.env`를 추적하지 않는다 (`server/.gitignore`). 처음 띄우는 머신에서 아래를 생성한다:

```dotenv
PORT=32173
NODE_ENV=development
# Phase 8 recording storage. local provider + dev-only PUT/GET handler 사용.
RECORDING_STORAGE_PROVIDER=local
RECORDING_STORAGE_PUBLIC_BASE_URL=http://localhost:32173/dev-recordings
# DB / JWT 등 기본 시드 (예시값 — 실제 dev에 맞게 조정).
DATABASE_URL=postgres://kloser_app:devpass@localhost:5432/kloser
DATABASE_MIGRATIONS_URL=postgres://kloser_admin:adminpass@localhost:5432/kloser
JWT_SECRET=dev-jwt-secret-change-me-please
```

주의:
- `RECORDING_STORAGE_PROVIDER=local` 가 아니면 `server/src/routes/devRecordingStorage.ts` 자기-게이트로 비활성화됨 → Step 6 archive 업로드가 signed URL에서 404를 받는다.
- `NODE_ENV=production` 으로 띄우면 같은 dev handler가 비활성화됨. 본 runbook 환경 외에서 production env로 띄울 때는 별도 storage provider (S3 / MinIO) 설정 필요 (본 phase 범위 밖).

### 1.3 DB migration + seed (최초 1회)

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run db:seed
```

migration 실패 시 `DATABASE_MIGRATIONS_URL`이 admin 권한인지 확인. seed 후 dev login 자격(`server/seeds/`에 기록)을 메모해 둔다.

### 1.4 Server (Fastify)

```powershell
npm --prefix server run dev
```

서버 부팅 로그에 다음이 보여야 한다:
- listening on port 32173
- routes registered including `/calls/*`, `/calls/:id/recordings/*`, `/dev-recordings/*` (NODE_ENV=development + local provider일 때만)

health check:

```powershell
curl http://localhost:32173/health
```

`{ "ok": true, ... }` 응답.

### 1.5 Static frontend

새 터미널에서 리포지토리 루트:

```powershell
python -m http.server 8765
```

브라우저:

- 플랫폼 진입: <http://localhost:8765/platform/>
- 통화 목록: <http://localhost:8765/platform/calls.html>

### 1.6 WPF desktop

새 터미널:

```powershell
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
```

처음 빌드는 ~10s. 이후 incremental 빌드는 ~2s.

창이 뜨면 상단 backend band:

- 백엔드 URL: `http://localhost:32173` (기본값 그대로).
- 이메일 + 비밀번호로 `로그인 + 연결`, 또는 dev fallback으로 `KLOSER_DESKTOP_ACCESS_TOKEN` 환경변수 / 페이스트 토큰.

---

## 2. 통화 시나리오 (smoke)

1. WPF 창에서 `로그인 + 연결` 또는 토큰 페이스트 → 소켓 = `Connected`.
2. `통화 시작` 클릭.
3. 마이크에 말하기 → `agent_mic` peak/RMS 움직임 + `mic chunks/bytes` 증가.
4. 시스템 오디오 재생 (YouTube, mp3) → `system_loopback` peak/RMS 움직임 + `loopback chunks/bytes` 증가.
5. 통화 30초~5분 유지 (S6 검증은 5분 이상).
6. `통화 종료` 클릭.
7. 녹취 archive 패널에서 `available` 상태 도달 확인 (수 초 ~ 수십 초).
8. <http://localhost:8765/platform/calls.html> 진입 → 방금 끝난 call 행 클릭 → 녹음 섹션에서 재생.

서버 사이드 DB 확인:

```sql
-- 최근 call 한 줄
SELECT id, status, started_at, ended_at FROM calls ORDER BY created_at DESC LIMIT 1;

-- 전사
SELECT seq, source, text FROM transcripts
WHERE call_id = '<위 call id>'
ORDER BY seq;

-- mock STT usage row
SELECT provider, operation, metadata
FROM llm_usage_log
WHERE call_id = '<위 call id>'
ORDER BY created_at DESC;

-- archive
SELECT id, status, duration_seconds, size_bytes, checksum_sha256, recorded_at
FROM call_recordings
WHERE call_id = '<위 call id>';
```

`call_recordings.status = 'available'`, `transcripts` 다수 row, `llm_usage_log.provider = 'mock'` + `operation = 'stt_transcribe'` 이어야 한다.

---

## 3. 자주 보는 실패 + 진단

| 증상 | 원인 추정 | 조치 |
|---|---|---|
| `소켓: Failed` + `백엔드 런타임 오류 없음` | server 미기동 또는 포트 차단 | `/health` 확인, `npm --prefix server run dev` 로그 확인 |
| 로그인 실패 + `invalid_credentials` | seed 자격 아님 / migration 미수행 | `npm --prefix server run db:seed` 재실행, seed dev 자격 확인 |
| 통화 시작 후 capture peak가 모두 0 | mic / loopback endpoint 누락 또는 mute | WPF 디바이스 콤보 박스에서 다른 endpoint 선택, OS 사운드 mixer 확인 |
| 통화 종료 후 archive `skipped_empty` | mic·loopback 둘 다 silence | 다음 통화에서 실 오디오를 직접 발생 (말하기 + 시스템 오디오 재생) |
| archive `initiate_failed` 401 | 액세스 토큰 만료 / 권한 부족 | 재로그인. desktop 사용자가 WRITER role(`admin`/`manager`/`employee`)인지 확인 |
| archive `upload_failed` + signed URL 404 | `RECORDING_STORAGE_PROVIDER` 미설정 / `NODE_ENV=production` | `server/.env` 확인 후 server 재기동 |
| calls.html에서 "녹음 없음" | archive 아직 in-flight / 실패 | archive 패널 server status 확인. `available`이면 페이지 reload |
| WPF가 시작하자마자 종료 | XAML / DI 문제 | 콘솔 출력 확인. `dotnet build` 단독으로 0/0 확인 |

서버 로그 보존:
- Fastify pino 로그가 stdout으로 흐름. 5분 baseline 같은 긴 시나리오는 `npm --prefix server run dev > server.log 2>&1` 같은 redirect로 보관. `server.log`는 `.gitignore`되지 않으므로 검토 후 수동 삭제.

---

## 4. 보안 정책 (운영자 숙지)

- `server/.env`, `server/.data/`, `*.wav`, `*.pcm`, `*.raw`, `*.log`, `bin/`, `obj/` 는 커밋 대상 아님 (`.gitignore` 확인).
- 액세스 토큰은 메모리에만 보관. 디스크 / Windows Credential Manager / 환경변수 영구 저장 안 함. `KLOSER_DESKTOP_ACCESS_TOKEN`은 dev fallback 한정.
- 비밀번호는 PasswordBox에 입력 후 메모리에서만 다뤄지고 login 성공 시 즉시 비워진다. 패널에 평문 표시되지 않는다.
- raw PCM, signed URL, object key, checksum, 로컬 archive 경로는 UI / Events / Errors / 콘솔 / 서버 로그 / DB / audit payload에 노출되지 않는다.
- diagnostic WAV (`agent_mic.wav` / `system_loopback.wav`)는 기본 OFF. 활성화 시 `desktop/.diagnostics/<stamp>/`에 실 음성이 평문으로 남으니 smoke 후 수동 삭제.
- archive WAV는 업로드 성공 시 자동 삭제되고, 실패 시도 함께 cleanup. 24시간 이상 남은 `%LOCALAPPDATA%\Kloser\recordings\pending\<callId>\` 디렉토리는 desktop 부팅 시 startup sweeper가 best-effort 청소 (Phase 9 Step 7 hardening).
- consent 체크박스는 **legal workflow가 아님**. 운영자가 고객에게 녹취/STT를 안내했음을 UI에 표기하는 placeholder.

---

## 5. 종료 + 정리

```powershell
# WPF: X 또는 Closing 핸들러로 archive 마무리(최대 30초) 후 종료.

# Server / static / docker
Ctrl-C    # server, http.server 각각
docker compose -f ops/docker-compose.yml down  # postgres 컨테이너 정지
```

`.diagnostics/<stamp>/` 폴더와 `server.log`는 필요 없으면 수동 삭제 (raw 음성이 남아 있을 수 있음).

---

## 6. 참조

- 상위 master: `PHASE_9_MASTER.md`
- desktop runbook 보충: `desktop/Kloser.Desktop.Shell/README.md`
- console PoC: `desktop/Kloser.Capture.Poc/README.md`
- backend recording route: `server/src/routes/callRecordings.ts`, `server/src/routes/devRecordingStorage.ts`
- backend audio ingest: `server/src/ws/calls.ts`, `server/src/types/wsAudio.ts`
