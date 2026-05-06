# Kloser · 테스트 스크립트

플랫폼의 8개 페이지를 자동으로 띄우고 헤드리스 Chromium으로 검증하는 Python 스크립트 모음입니다.

## 사전 준비

```bash
pip install playwright
python -m playwright install chromium
```

## 실행 방법

먼저 프로젝트 루트에서 정적 서버를 띄웁니다:

```bash
# 프로젝트 루트(kloser/)에서
python -m http.server 8765
```

그 다음 `test/` 폴더에서 원하는 스크립트 실행:

```bash
cd test
python smoke_desktop.py     # 8개 페이지 데스크톱 (1280x800) 검증
python smoke_mobile.py      # 8개 페이지 모바일 (390x844) 검증 + 사이드바 토글
python smoke_daily.py       # daily.html 단독 깊이 검증
python test_features.py     # 알림 패널 + Word 다운로드 검증
python screenshots.py       # screenshots/ 폴더에 PNG 캡처
```

각 스크립트는 콘솔 에러를 캡처해 `errs=N`으로 보고합니다.

## 스크린샷 폴더

`screenshots/` — 시각 회귀 검증용 캡처본
- `daily_desktop.png`
- `customers_desktop.png`
- `customers_mobile_closed.png` / `customers_mobile_open.png`
- `notification_dashboard.png` / `notification_live.png`

## 주의

- 스크립트들은 `http://localhost:8765/platform/...`을 가정합니다. 포트가 다르면 각 파일에서 URL 수정 필요.
- 일부 스크립트는 캡처 결과를 현재 작업 디렉토리에 저장합니다. `cd test`에서 실행하면 `test/`에 저장됩니다.
