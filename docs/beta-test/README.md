# 🎧 AIMASTER 베타 테스트 문서

v3.4.1 베타 테스트를 위한 모든 자료를 한 곳에 모았습니다.

## 파일 구성

| 파일 | 누구를 위한 것 | 사용 시점 |
|------|---------------|----------|
| [`BETA_TESTER_MESSAGE.md`](./BETA_TESTER_MESSAGE.md) | 베타 테스터 | 테스트 요청 시 보낼 메시지 |
| [`USER_CHECKLIST.md`](./USER_CHECKLIST.md) | 베타 테스터 | 청취하면서 채우는 간단 체크리스트 |
| [`FEEDBACK_TEMPLATE.md`](./FEEDBACK_TEMPLATE.md) | 베타 테스터 | 자유 형식 회신 템플릿 |
| [`feedback_template.json`](./feedback_template.json) | 베타 테스터 (선택) | 구조화된 JSON 회신 |
| [`INTERNAL_CHECKLIST.md`](./INTERNAL_CHECKLIST.md) | **개발팀** | 받은 결과 분석 시 |
| [`analyze_feedback.py`](./analyze_feedback.py) | **개발팀** | 피드백 + 결과 자동 cross-check |

## 워크플로우

```
1. 개발팀 → 베타 테스터에게 BETA_TESTER_MESSAGE.md 전송
2. 베타 테스터 → 테스트 진행하며 USER_CHECKLIST 또는 FEEDBACK_TEMPLATE 작성
3. 베타 테스터 → 디버그 번들 + 작성한 피드백 회신
4. 개발팀 → INTERNAL_CHECKLIST 항목별 검증
5. 개발팀 → analyze_feedback.py 로 측정-청감 불일치 자동 추출
6. 개발팀 → 다음 패치 우선순위 결정
```

## analyze_feedback.py 사용법

```bash
# 단일 피드백 분석
python3 analyze_feedback.py feedback.json

# 피드백 + 결과 JSON 같이 (engineMetrics 자동 추출)
python3 analyze_feedback.py feedback.json result.json

# 디렉터리 일괄 처리 (feedback*.json + result*.json 자동 매칭)
python3 analyze_feedback.py --batch ./responses/
```

출력 예시:

```
# Beta feedback report — 테스터1
## MyTestSong
  A: KPOP Loud  — score 4/5
     ✓ vocal: vocalLossDb 0.50 dB (정상) ↔ 사용자 'good'
     · comp : crest -20% LRA -30%
  C: Reference  — score 3/5
     ⚠ ref  : reference score 85 인데 사용자 'different' 평가.

## ⚠ Measurement vs perception mismatches
  [C: Reference] ⚠ reference score 85 인데 사용자 'different' 평가.
```

`⚠ mismatch` 가 핵심 — 측정과 청감이 안 맞는 케이스가 다음 패치 우선순위.

## 결과 종합 시 판정 기준

| 측정 | 사용자 평가 | 의미 | 액션 |
|------|------------|------|------|
| 정상 | 만족  | 잘 작동 | 유지 |
| 정상 | 불만  | 측정에 안 잡히는 문제 | **새 측정 지표 발굴 필요** |
| 위험 | 만족  | 측정 임계값 너무 민감 | **임계값 조정** |
| 위험 | 불만  | 엔진 추가 보호 필요 | **다음 패치에서 처리** |

## 엔진 측정 지표 위치 빠른 참고

| 측정 | 결과 JSON 경로 |
|------|---------------|
| 보컬 손실 | `gainStaging.vocalLossDb` |
| crest 감소 | `gainStaging.crestFactorDropPct` |
| LRA 감소 | `gainStaging.lraDropPct` |
| 백그라운드 상승 | `gainStaging.backgroundRiseDb` |
| limiter 종합 | `limiterCheck.overall` |
| 자동 품질 검사 | `qualityCheck.overall` |
| 의심 구간 | `suspectSegments[*]` |
| 보컬 보호 동작 | `vocalProtection.appliedClamps` |
| reference 매칭 | `referenceMatch.overall` |
| reference 경고 | `referenceWarnings[*]` |
| 자동 추천 | `modeRecommendations[*]` |
