# SLA 99.9% 서버 구성 상세 정리

## 0. 결론

SLA 99.9%를 목표로 하면 최소 구성:

- Load Balancer 2대
- App 서버 2대
- Worker 서버 2대
- PostgreSQL 3대
- Redis 3대
- Backup NAS 1대
- Monitoring 서버 1대

총 약 8~10대 구성 필요

---

## 1. 핵심 개념

- SLA 99.9% = 장애가 나도 서비스 지속
- 모든 핵심 시스템은 최소 2개 이상 필요

---

## 2. 전체 구조

```
[인터넷]
   ↓
[방화벽 2대]
   ↓
[Load Balancer 2대]
   ↓
[App 서버 2대]
   ↓
[Worker 서버 2대]
   ↓
[PostgreSQL 3대]
   ↓
[Redis 3대]
   ↓
[Backup NAS]
   ↓
[Monitoring]
```

---

## 3. 서버별 역할

### Load Balancer
- 트래픽 분산
- 장애 서버 자동 제외

### App 서버
- API 처리
- WebSocket
- 인증

### Worker 서버
- AI 처리
- STT
- 백그라운드 작업

### PostgreSQL
- Primary + Replica
- 데이터 저장 핵심

### Redis
- Queue
- Cache
- Rate limit

### Backup
- 데이터 백업
- 장애 복구

### Monitoring
- 장애 감지
- 알림

---

## 4. 권장 사양

| 역할 | CPU | RAM | Storage |
|------|----|----|--------|
| LB | 4~8 core | 8~16GB | SSD |
| App | 16 core | 64GB | NVMe |
| Worker | 16~32 core | 64~128GB | NVMe |
| DB | 16~32 core | 128GB+ | NVMe |
| Redis | 8 core | 32~64GB | NVMe |

---

## 5. 비용

- 최소: 약 1억 원
- 권장: 1.5억 ~ 2.5억 원
- 운영비: 별도

---

## 6. 운영 필수 요소

- 백업 + 복구 테스트
- 모니터링 + 알림
- 로그 관리
- 배포 자동화
- 장애 대응 프로세스

---

## 7. 단계별 전략

### Phase 1
- 단일 서버
- SLA 없음

### Phase 2
- App 이중화
- Load Balancer

### Phase 3 (Enterprise)
- 전체 HA 구성
- SLA 99.9%

---

## 최종 결론

단일 서버로 SLA 99.9%는 불가능  
Enterprise 전에 반드시 HA 전환 필요
