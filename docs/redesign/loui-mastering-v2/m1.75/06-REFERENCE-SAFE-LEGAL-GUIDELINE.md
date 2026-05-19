# M1.75 — Reference-Safe Legal Guideline

> 본 문서는 **법무 검토 대상** 이다.  본 시스템이 저작권 / 데이터보호 / 부정경쟁법
> 측면에서 안전한 이유를 명시한다.  실제 출시 전 외부 변호사 리뷰 필수.

---

## 1. 핵심 주장

> Loui 의 **ReferenceProfile** 은 녹음물의 **사실(facts)** 만 담는다 —
> 저작물의 derivative 가 아니며, fingerprint 가 아니며, 식별자가 아니다.

이를 schema / validator / 코드의 3중 layer 로 강제한다.

---

## 2. 법적 프레임워크 (요약 — 변호사 확인 필요)

### 2.1 미국 (US Copyright)

- **Feist v. Rural Telephone (1991)**: 사실은 저작권 보호 대상이 아님.  
  → Loudness, LRA, spectral balance 등 **녹음물의 객관적 측정값** 은 사실.
- 그러나 sound recording 의 reproduction / derivative work 는 보호됨.  
  → audio 데이터를 그대로 / 변형해 저장하면 침해 위험.
- DMCA §1201 — DRM 회피 금지.  
  → fingerprint hashing 으로 ID 매칭은 회피 효과 가능 → 회피.
- "Hot news" doctrine 은 적용 범위 제한적, 본 시스템에 무관.

### 2.2 EU (Directive 2001/29/EC, 2019/790)

- 녹음물의 reproduction right + making available right 보호.
- **Text and Data Mining (TDM) exception** (Article 4): 합법적으로 접근 가능한 콘텐츠에 대한 statistical extraction 허용.  
  → 사용자가 합법적으로 보유한 reference 의 통계적 분석은 TDM 해당.
- **신경망 학습 vs 통계 추출**: Loui 의 추출은 통계 (LUFS, LRA, spectrum) 이지 신경망 weight 가 아니므로 더 명확.

### 2.3 한국 (저작권법)

- 제 35조의5 (저작물의 공정한 이용): 공정이용 4-factor 적용.
  - 목적: 비영리적 또는 상용 마스터링 도구의 보조 분석 — 공정이용 인정 가능.
  - 성격: 음악 저작물 (보호 강함).
  - 양: **객관적 측정값만** (저작물 자체가 아님).
  - 시장 영향: 마스터링 도구가 reference 의 시장을 대체하지 않음.
- **데이터마이닝 면책** 도입 논의 중 (저작권법 개정안) — TDM 명문화 시 더 명확.

### 2.4 결론

본 시스템의 ReferenceProfile 추출 / 저장 / 공유는 **사실의 통계적 추출** 로
간주되며, 저작권 침해 위험은 매우 낮다 (변호사 final 의견 필요).

---

## 3. 시스템 레벨 보호 invariant

각 invariant 가 **schema validator** 에 의해 실행 시점에 강제됨:

### Invariant 1: No audio sample storage
- Extractor 는 `samples` 배열을 함수 종료 직전 `del`.
- profile JSON 에는 어떤 sample 도 없음.

### Invariant 2: No time-series data
- Validator: features 안의 array length > 200 = 거부.
- Spectrogram, momentary LUFS history 등 모두 차단.

### Invariant 3: No phase information
- Extractor 는 `np.fft.rfft` 의 magnitude 만 사용 (`np.abs`).
- Phase 정보는 측정되지 않음 → 저장 불가.

### Invariant 4: Frequency resolution cap
- Validator: `thirdOctSpectrumDb` 의 키 수 > 64 = 거부.
- 1/3-oct 30 bins → fingerprint 해상도 영역 아래.
  (참고: ACR 같은 audio fingerprinting 은 일반적으로 256+ bin spectrogram 사용.)

### Invariant 5: No identifying metadata
- Validator: `provenance` 에 `artist`/`title`/`album`/`lyrics`/`isrc`/`mbid` 키가 있으면 거부.
- 사용자가 첨부할 수 있는 것은 `userLabel` (free-form text) 만 — **사용자 책임 명시**.

### Invariant 6: No content fingerprint
- `sourceFileSha256` 은 **사용자가 보유한 파일의 sha256** 이며, OPTIONAL.
- 공유용 profile 에서는 stripping 권장 (스키마에 명시).
- `featureFingerprint` 는 **features dict 의 sha256** — audio 와는 무관.

### Invariant 7: Aggregate-only
- 모든 dynamics / loudness 측정값은 단일 scalar 또는 P10/P50/P90 percentile.
- 시계열 → 분포 통계로 강제 환원.

---

## 4. "Cloning" 방지

Adaptive mastering 의 nudge 값이 reference 의 정확한 톤을 복제하지 못하도록:

| Override | Range | "Clone 안 됨" 근거 |
|---|---|---|
| `targetLufsAdjustDb` | ±2 dB | preset 의 LUFS targets 가 ±2 dB 안에만 움직임 |
| `eqAirShelfDeltaDb`  | ±2 dB | shelf 톤은 reference 의 fine EQ 곡선 복제 불가 |
| `eqLowShelfDeltaDb`  | ±2 dB | 같음 |
| `saturationDelta`    | ±0.10 | 0..1 스케일의 10% — 절대값 limit |
| `stereoWidthDelta`   | ±0.10 | width 의 미세 nudge |

**3-band 이하 EQ + 한정된 라우드니스 nudge + saturation/width 미세 조정**
의 조합은 "reference 와 비슷한 character" 를 만들지만 "reference 와 같은 신호"
는 만들 수 없다.

다중 reference 평균 사용 (M2+) 도 cloning 보호 강화:
- 3-5 곡의 평균 → 어느 한 곡의 identity 가 출력에 dominant 하지 않음.

---

## 5. 사용자 책무 명시 (EULA 항목)

상용 출시 시 EULA 에 다음 명시 권장:

```
사용자는 다음을 보장합니다:
  (a) reference 로 업로드하는 모든 audio 파일에 대한 합법적 소유권 또는 합법적
      접근 권한을 보유.
  (b) reference 의 userLabel 필드에 입력하는 모든 텍스트는 사용자 책임.
      해당 텍스트가 제3자의 권리를 침해할 수 있는 식별자 (artist, song title,
      ISRC 등) 인 경우 사용자가 그 책임을 단독으로 부담.
  (c) 추출된 ReferenceProfile JSON 의 외부 공유 / 마켓플레이스 업로드는
      사용자가 reference 원본의 저작권자가 아닌 경우 권리자의 허락이
      필요할 수 있음을 인지.

Loui 는 다음을 보장합니다:
  (a) ReferenceProfile JSON 은 본 schema 명세에 의해 audio 재구성이 불가능한
      통계적 데이터만 포함.
  (b) Loui 서비스는 ReferenceProfile 에서 audio 식별을 시도하지 않음
      (예: external ACR 데이터베이스 매칭).
  (c) 사용자가 profile 을 삭제 요청 시 24시간 이내에 시스템에서 제거.
```

---

## 6. 외부 데이터베이스 / API 사용 금지

다음과 같은 외부 시스템 사용은 본 모듈에서 **금지** :

- ACR (Automatic Content Recognition) APIs — Shazam, ACRCloud, etc.
- 음악 메타데이터 lookup — MusicBrainz, Discogs, Spotify API
- Lyric services
- Cover art services

본 모듈은 **로컬 audio 만** 분석한다. 어떤 외부 lookup 도 일어나지 않는다.

위반 시 schema 가 보호하지 않는 부분에서 사실관계가 발생 (e.g. "이 sha256 은 
이 ISRC 와 매칭됨" 등). 그러한 코드는 본 모듈에 절대 추가하지 않는다.

---

## 7. 침해 신고 / 삭제 절차 (M3+)

마켓플레이스 / 사용자 profile 공유 기능 (M3+) 에 다음 절차 의무:

1. **신고 채널**: profile 공개 페이지에 "Report" 버튼.
2. **신속 삭제**: 신고 24시간 이내 임시 비공개 → 7일 이내 조사 → 확정.
3. **DMCA agent designation** (미국 시장).
4. **권리자 직접 청구 채널**: legal@loui.studio (또는 동등).
5. **삭제된 profile 의 audit log** 보존 (정책 검증용).

---

## 8. Schema 진화 가이드

신규 feature 추가 시 본 가이드 재검토 의무:

1. **신규 feature 가 시계열 데이터인가?** → NO 만 허용.
2. **신규 feature 의 해상도가 fingerprinting 영역인가?** (e.g. spectrogram, 256+ bin spectrum) → 거부.
3. **신규 feature 가 사용자 / 권리자 식별을 가능케 하는가?** → 거부.
4. **신규 feature 가 음악 식별 데이터베이스 (ACR) 와 매칭 가능한가?** → 거부.

스키마 진화는 본 가이드를 깨지 않는 한도에서만.

---

## 9. 본 가이드의 한계

본 문서는 엔지니어링 가이드라이며 **법률 조언이 아니다**.

상용 출시 전 다음 절차 필수:
1. 외부 변호사 검토 (저작권 / 데이터보호 / 부정경쟁법)
2. 시장별 (US / EU / KR / JP) 특화 검토
3. EULA / 약관 / 개인정보처리방침 작성
4. DMCA agent 등록 (US)
5. GDPR DPA / DSGVO 준비 (EU)
6. 한국 개인정보보호위원회 정책 검토

본 가이드는 그 검토를 시작점부터 안전한 자세로 만든다.
