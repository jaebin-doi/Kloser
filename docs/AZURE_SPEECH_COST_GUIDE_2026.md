# Azure Speech 비용 가이드 2026

> 작성일: 2026-05-07  
> 기준 페이지: https://azure.microsoft.com/ko-kr/pricing/details/speech/  
> 보조 검증: Azure Retail Prices API, `armRegionName=koreacentral`, `currencyCode=KRW`  
> 목적: Kloser에서 Azure Speech를 실시간 STT 후보로 POC/운영할 때 비용 구조를 빠르게 산정하기 위한 문서

---

## 0. 결론

Kloser가 Azure Speech를 **한국어 실시간 상담 STT**로 쓸 경우, 1차로 봐야 할 비용 항목은 다음이다.

| 용도 | Azure meter | 2026-05-07 Korea Central KRW 기준 |
|---|---|---:|
| 기본 실시간 STT | `S1 Speech To Text` | **1,473.55원 / audio hour** |
| 실시간 STT + diarization 등 추가 기능 1개 | `S1 Speech To Text` + `S1 Speech to Text Enhanced Feature Audio` | **1,915.615원 / audio hour** |
| Custom Speech 실시간 STT | `S1 Custom Speech To Text` | **1,768.26원 / audio hour** |
| Batch STT | `S1 Speech to Text Batch` | **265.239원 / audio hour** |
| Fast Transcription | `Fast Transcription Speech To Text` | **530.478원 / audio hour** |
| Conversation Transcription audio | `S1 Conversation Transcription Audio` | **1,768.26원 / audio hour** |
| Conversation Transcription multichannel | `S1 Conversation Transcription Multichannel Audio` | **3,094.455원 / audio hour** |

실시간 상담 보조 MVP 기준 추천:

```text
기본: S1 Speech To Text
옵션: diarization이 실제로 필요할 때만 Enhanced Feature 1개 추가
Batch: 통화 종료 후 재처리/검색 품질 향상용으로 별도 사용
Custom Speech: 도메인 용어 POC 후 효과가 명확할 때만 도입
```

---

## 1. 공식 가격 페이지에서 확인한 과금 원칙

Azure Speech 가격 페이지 기준:

- 가격은 **예상값**이며 실제 청구 가격은 계약, 구매 날짜, 환율에 따라 달라질 수 있다.
- Speech to Text는 **per second billing**으로 표기된다.
- Speech to Text 사용량은 **서비스로 전송한 audio 시간** 기준으로 측정된다.
- Free F0는 Speech to Text에 대해 **월 5 audio hours free**를 제공한다.
- Free Speech to Text 시간은 Standard와 Custom 간 공유된다.
- Batch는 Free F0에서 지원되지 않는다고 명시되어 있다.
- Real-time enhanced add-on feature는 기능별 audio hour 단위로 추가 과금된다.
- Batch의 Continuous Language Identification / Diarization은 Standard/Custom에 포함된다고 표기되어 있다.

중요한 해석:

```text
실시간 연결 시간이 아니라 "Azure로 보낸 audio duration"이 핵심 과금 기준이다.
침묵 구간도 오디오로 계속 보내면 과금 대상이 될 수 있다.
따라서 VAD/silence gating은 비용 최적화에 직접 영향을 준다.
```

---

## 2. Korea Central 주요 단가

아래 값은 2026-05-07에 Azure Retail Prices API로 확인한 `koreacentral` + `KRW` retail price다. 실제 계약/환율/프로그램에 따라 달라질 수 있다.

| 분류 | Meter | Unit | 단가 |
|---|---|---:|---:|
| Real-time STT | `S1 Speech To Text` | 1 Hour | 1,473.5500원 |
| Real-time enhanced feature | `S1 Speech to Text Enhanced Feature Audio` | 1 Hour | 442.0650원 |
| Custom real-time STT | `S1 Custom Speech To Text` | 1 Hour | 1,768.2600원 |
| Standard batch STT | `S1 Speech to Text Batch` | 1 Hour | 265.2390원 |
| Custom batch STT | `S1 Custom Speech to Text Batch` | 1 Hour | 331.5487원 |
| Fast transcription | `Fast Transcription Speech To Text` | 1 Hour | 530.4780원 |
| Custom fast transcription | `Custom - Fast Transcription Speech To Text` | 1 Hour | 663.0975원 |
| Conversation transcription audio | `S1 Conversation Transcription Audio` | 1 Hour | 1,768.2600원 |
| Conversation transcription multichannel | `S1 Conversation Transcription Multichannel Audio` | 1 Hour | 3,094.4550원 |
| Speech translation | `S1 Speech Translation` | 1 Hour | 3,683.8750원 |
| Custom Speech model hosting | `S1 Custom Speech Model Hosting Unit` | 1 Hour | 79.2033원 |
| Custom Speech model hosting | `S1 Custom Speech Model Hosting Unit` | 1 Day | 1,901.3540원 |

---

## 3. 비용 계산 공식

## 3.1 실시간 STT 기본

```text
월 STT 비용 =
  월 전송 audio hours
  × STT 단가
```

월 전송 audio hours:

```text
상담원 수
× 상담원당 일평균 통화 시간
× 월 근무일
× audio 전송 계수
```

`audio 전송 계수`:

| 전송 방식 | 계수 | 설명 |
|---|---:|---|
| 전체 통화 구간을 계속 전송 | 1.0 | 가장 단순, 비용 높음 |
| VAD로 긴 침묵 제거 | 0.65 ~ 0.85 | 실전에서 검증 필요 |
| 고객/상담원 양쪽 모두 별도 채널 전송 | 1.0 ~ 2.0 | multi-channel 과금 구조 확인 필요 |

## 3.2 diarization 포함

공식 가격표의 enhanced add-on feature에는 다음이 포함된다.

- Continuous Language Identification
- Diarization
- Pronunciation Assessment, prosody

Real-time은 feature별 hour 과금이다.

```text
월 비용 =
  audio hours
  × (기본 STT 단가 + enhanced feature 단가 × 사용 feature 수)
```

예:

```text
기본 STT + diarization 1개 =
1,473.55 + 442.065
= 1,915.615원 / audio hour
```

## 3.3 Custom Speech 포함

Custom Speech는 사용 형태가 세 갈래다.

| 항목 | 비용 성격 |
|---|---|
| Custom real-time STT | 기본 실시간 STT보다 높은 audio hour 단가 |
| Custom Speech training | compute hour 과금 |
| Custom Speech model hosting | model/hour 또는 model/day 과금 |

Custom Speech는 단순히 "더 좋은 품질"을 기대하고 켜면 안 된다. 다음을 만족할 때만 쓴다.

- 제품명/회사명/업계 용어 인식률이 기본 모델에서 낮다.
- phrase list 또는 domain adaptation으로 개선 효과가 실측된다.
- hosting 비용까지 포함해도 운영 비용 대비 품질 개선 가치가 있다.

---

## 4. Kloser 시나리오별 월 비용 예시

아래는 단순 계산 예시다.

가정:

- Region: Korea Central
- Currency: KRW
- 월 근무일: 시나리오별 표기
- Free 5 hours/month는 제외하지 않음
- VAT/계약 할인/환율 변동/네트워크 비용은 제외

| 시나리오 | 상담원 수 | 일평균 통화 시간 | 월 근무일 | 월 audio hours | 기본 실시간 STT | 기본 + diarization 1개 | Custom 실시간 STT | Batch STT | Fast Transcription |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| POC | 5 | 1h | 20 | 100h | 147,355원 | 191,562원 | 176,826원 | 26,524원 | 53,048원 |
| Small | 10 | 3h | 22 | 660h | 972,543원 | 1,264,306원 | 1,167,052원 | 175,058원 | 350,115원 |
| Growth | 50 | 4h | 22 | 4,400h | 6,483,620원 | 8,428,706원 | 7,780,344원 | 1,167,052원 | 2,334,103원 |
| Scale | 100 | 5h | 22 | 11,000h | 16,209,050원 | 21,071,765원 | 19,450,860원 | 2,917,629원 | 5,835,258원 |

해석:

- 실시간 상담 보조는 Growth 단계에서 월 수백만 원대 STT 비용이 발생할 수 있다.
- diarization 같은 enhanced feature는 월 audio hours가 커질수록 비용 영향이 커진다.
- 통화 종료 후 batch 재처리는 실시간보다 훨씬 저렴하지만, 실시간 UX를 대체하지는 못한다.
- POC 단계에서는 Azure Free F0 5시간이 도움이 되지만, 실제 벤치마크에는 거의 의미 없는 수준이다.

---

## 5. Kloser 제품별 비용 적용 판단

## 5.1 live.html 실시간 상담 보조

권장:

```text
S1 Speech To Text
```

처음부터 diarization을 켜지 말고, 현재 통화 구조에서 정말 필요한지 확인한다.

1:1 상담이라면 speaker를 클라이언트/채널 구조로 이미 알 수 있을 가능성이 있다. 이 경우 Azure diarization 비용을 내지 않아도 된다.

## 5.2 다자간 회의/회의록

권장 후보:

```text
S1 Speech To Text + Diarization
또는 Conversation Transcription
```

다자간 회의, overlap speech, speaker 분리가 핵심이면 diarization 비용을 감수할 수 있다.

## 5.3 통화 종료 후 고품질 재처리

권장:

```text
Batch STT
또는 Fast Transcription
```

실시간 transcript는 상담 중 UI용으로 쓰고, 저장/검색/요약 품질은 batch 재처리로 보강하는 구조가 비용 효율적일 수 있다.

권장 구조:

```text
실시간:
  S1 Speech To Text → 상담 UI partial/final

통화 종료 후:
  Batch STT 또는 Fast Transcription → 저장 transcript 보정 → 요약/검색 인덱싱
```

## 5.4 도메인 용어가 많은 B2B 상담

권장:

```text
기본 STT POC
→ phrase/custom vocabulary 실험
→ 개선 폭이 크면 Custom Speech 검토
```

Custom Speech는 단가뿐 아니라 training/hosting 비용이 붙는다. 단순 POC 단계에서는 기본 모델로 먼저 baseline을 만든다.

---

## 6. 비용 최적화 전략

## 6.1 VAD/silence gating

Azure는 audio sent 기준 과금이므로, 침묵을 계속 전송하면 비용이 늘어난다.

권장:

- client 또는 server에서 VAD 적용
- 긴 침묵 구간은 STT로 보내지 않음
- 단, 너무 aggressive한 VAD는 첫 음절 손실을 만든다
- POC에서 `cost_saved_percent`와 `first_syllable_drop_rate`를 함께 측정

## 6.2 diarization을 기본값으로 켜지 않기

1:1 상담에서 speaker 정보를 이미 아는 경우:

- 상담원 마이크와 고객 음성 채널이 분리되어 있으면 diarization 불필요
- telephony provider가 channel 정보를 주면 diarization 불필요
- UI에서 `agent/customer`를 채널 기준으로 붙이면 비용 절감

diarization은 다음 경우에만 켠다.

- 회의/다자간 통화
- single mixed audio만 있고 speaker 분리가 꼭 필요
- 고객별 발화량/감정 분석이 speaker 기준으로 필요

## 6.3 실시간 + batch 이중 구조

실시간 transcript는 UX에 최적화하고, 최종 저장 품질은 batch로 보정한다.

장점:

- 실시간 비용은 유지하면서 저장 품질 향상
- 실시간 diarization을 끄고 batch diarization으로 대체 가능성 검토
- 상담 중 AI 제안과 사후 요약 품질을 분리 최적화

주의:

- raw audio 저장 정책이 필요하다.
- 개인정보/동의/retention 정책이 필요하다.

## 6.4 Free F0 활용

Free F0:

- Standard Real-time Transcription 5 audio hours/month
- Custom Real-time Transcription 5 audio hours/month
- Standard/Custom Speech to Text free hours는 공유

활용:

- SDK 연결 smoke test
- 간단한 개발자 로컬 테스트

한계:

- 실제 POC benchmark에는 부족하다.
- 동시성/쿼터 제한이 있을 수 있다.
- 운영 비용 판단에는 포함하지 않는다.

---

## 7. 비용 로깅 설계

Azure 비용을 예측하려면 Kloser 내부에서 audio duration을 반드시 기록해야 한다.

`stt_usage_logs` 예시:

```sql
CREATE TABLE stt_usage_logs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  call_id uuid NOT NULL,
  provider text NOT NULL,
  region text NOT NULL,
  meter text NOT NULL,
  audio_ms_sent bigint NOT NULL,
  enhanced_features text[] NOT NULL DEFAULT '{}',
  estimated_unit_price_krw numeric(12, 4),
  estimated_cost_krw numeric(14, 4),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

계산:

```text
estimated_cost_krw =
  audio_ms_sent / 3,600,000
  × unit_price_krw
```

실시간 session 중 누적할 지표:

- `audio_ms_captured`
- `audio_ms_sent_to_azure`
- `audio_ms_suppressed_by_vad`
- `partial_count`
- `final_count`
- `first_partial_ms`
- `final_after_silence_ms`
- `azure_error_count`
- `reconnect_count`
- `estimated_cost_krw`

---

## 8. POC 예산

Azure Speech POC는 아래 정도로 잡는다.

| 항목 | 시간 | 단가 기준 | 예상 |
|---|---:|---:|---:|
| 기본 STT 한국어 benchmark | 100h | 1,473.55원/h | 147,355원 |
| diarization 포함 benchmark | 100h | 1,915.615원/h | 191,562원 |
| Fast Transcription 비교 | 100h | 530.478원/h | 53,048원 |
| Batch 재처리 비교 | 100h | 265.239원/h | 26,524원 |

권장 POC budget:

```text
최소: 20만 원
권장: 50만 원
넉넉한 비교 POC: 100만 원
```

단, 이 금액은 Azure Speech 사용량만이다. 개발 서버, 저장소, 네트워크, OpenAI/Deepgram/NAVER 비교 비용은 별도다.

---

## 9. 운영 전 확인해야 할 비용 질문

Microsoft/Azure Portal 또는 계약 담당자에게 확인할 것:

1. Korea Central에서 실제 청구 단가가 Retail API와 같은가?
2. VAT가 별도인지 포함인지?
3. 조직 계약/스타트업 크레딧/commit discount가 있는지?
4. enhanced feature를 여러 개 동시에 켜면 feature별로 모두 더해지는지?
5. diarization이 Conversation Transcription meter로 잡히는 경우와 Enhanced Feature meter로 잡히는 경우의 차이는 무엇인지?
6. silence audio도 전송하면 그대로 과금되는지?
7. streaming 연결 유지 중 audio를 보내지 않는 시간은 과금되지 않는지?
8. batch diarization이 실제로 추가 과금 없이 포함되는지?
9. Custom Speech hosting을 켜두면 미사용 시간에도 계속 과금되는지?
10. monthly commitment tier가 어느 사용량부터 유리한지?

---

## 10. Kloser 현재 권장안

Step 4 이후 실제 STT를 붙일 때 Azure는 이렇게 시작한다.

1. **기본 실시간 STT만 연결**
   - `S1 Speech To Text`
   - diarization off
   - audio duration/cost log부터 구현

2. **POC에서 diarization 별도 측정**
   - 비용: +442.065원/h
   - speaker 분리 품질이 실제로 비용을 정당화하는지 확인

3. **통화 종료 후 batch 재처리 검토**
   - 실시간 transcript와 batch transcript 품질 비교
   - 저장/검색용 transcript는 batch가 더 비용 효율적일 수 있음

4. **Custom Speech는 마지막**
   - domain term accuracy가 낮을 때만 검토
   - training/hosting/운영 비용까지 포함해서 판단

---

## 11. 출처

- Azure AI Speech 가격 페이지: https://azure.microsoft.com/ko-kr/pricing/details/speech/
- Azure Retail Prices API: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
- Azure Speech 언어 지원: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support

