# M1.5 — 스트리밍 플랫폼 라우드니스 정규화 대응 전략

> 마스터링 결과물은 플랫폼에서 다시 정규화된다.
> 본 문서는 각 플랫폼의 동작과, 그에 맞춘 Loui 의 출력 정책을 명시한다.

---

## 1. 플랫폼별 정규화 매트릭스

| 플랫폼 | 정규화 타겟 | TP 권장 | 정규화 방향 | 비고 |
|---|---:|---:|---|---|
| **Spotify** (Web/Mobile) | **−14 LUFS** | ≤ −1 dBTP | both (raise + lower) | "loudness normalization on" 기본. 사용자 설정으로 −19 / −11 / off 변경 가능. |
| **Spotify** (web HTML5) | −14 LUFS | ≤ −1 | only lower | 일부 클라이언트에서 raise 안 함. |
| **YouTube** | **−14 LUFS** | ≤ −1 | only lower | 라우드 곡만 깎음. 조용한 곡은 그대로. |
| **YouTube Music** | **−14 LUFS** | ≤ −1 | only lower | YouTube 와 동일. |
| **Apple Music** | **−16 LUFS** | ≤ −1 | both | "Sound Check" on 시 활성. 기본은 ON. |
| **Tidal** | **−14 LUFS** | ≤ −1 | both | "Normalization" 설정 on 시. |
| **Amazon Music** | **−14 LUFS** (추정) | ≤ −1 | both | 공식 문서 부족, 측정 기준. |
| **Deezer** | **−15 LUFS** | ≤ −1 | both | |
| **SoundCloud** | **none** | ≤ −1 | — | 정규화 안 함 — 마스터의 절대 라우드니스가 그대로 재생. |
| **Bandcamp** | **none** | ≤ −1 | — | SoundCloud 동일. |
| **TikTok / Reels** | **−14 LUFS** (추정) | ≤ −1 | only lower | 짧은 클립이라 다이내믹 정규화는 거의 무의미. |
| **EBU broadcast (TV)** | **−23 LUFS** | ≤ −1 | strict | EBU R128 ± 0.5 LU. |
| **ATSC A/85 broadcast (US TV)** | **−24 LKFS** | ≤ −2 | strict | LKFS = LUFS. |
| **AES (cinema reference)** | **−27 LUFS** | ≤ −2 | strict | 영화관 기준. |

**핵심 결론**:
- 대부분의 스트리밍 = **−14 LUFS 정규화** 가 표준.
- Apple Music 만 **−16 LUFS** (Sound Check) → 더 조용한 환경.
- SoundCloud / Bandcamp 는 **정규화 없음** → 마스터링 절대값이 사용자 청취에 그대로.

---

## 2. 마스터링 LUFS 가 정규화 후 어떻게 들리나

| 마스터 LUFS | Spotify 재생 시 | YouTube Music 재생 시 | Apple Music 재생 시 | SoundCloud 재생 시 |
|---:|---:|---:|---:|---:|
| −8 (loud) | −14 (−6 dB 감쇠) | −14 (−6 dB 감쇠) | −16 (−8 dB) | **−8** (그대로) |
| −10 | −14 (−4 dB) | −14 (−4 dB) | −16 (−6 dB) | **−10** |
| −12 | −14 (−2 dB) | −14 (−2 dB) | −16 (−4 dB) | **−12** |
| **−14** | −14 (그대로) | −14 (그대로) | −16 (−2 dB) | **−14** |
| −16 | −14 (+2 dB amp ↑ if config) | **−16** (정규화 안 함) | −16 (그대로) | **−16** |
| −20 | −14 (+6 dB amp ↑) | **−20** | −16 (+4 dB) | **−20** |

**중요 관찰:**
- **−14 LUFS** 가 모든 플랫폼에서 가장 안정 — 거의 모든 곳에서 그대로 재생.
- **너무 라우드** 마스터는 어차피 깎여 들리지만, 다이내믹 손실은 회복 안 됨 → **−8 마스터를 −14 로 들으면 압축감만 남는다.**
- **너무 조용** 마스터는 SoundCloud 같은 비정규화 플랫폼에서 음압 손해.

---

## 3. Loui 의 프리셋 → 플랫폼 권장 매핑

| 프리셋 | 마스터 LUFS | 1순위 플랫폼 | 2순위 | 비권장 |
|---|---:|---|---|---|
| `natural` | −14 | Spotify / Apple Music / YouTube Music / Tidal | Bandcamp | SoundCloud (조용함) |
| `balanced` | −12 | 범용 (Spotify 에서 -2 dB, 큰 손해 없음) | TikTok / Reels | Apple Music 만 사용 시 −14 권장 |
| `bright` | −12 | 보컬 중심 — Spotify / Apple Music | YouTube Music | — |
| `warm` | −14 | Apple Music / Ballad 전용 | Spotify | EDM 플랫폼 |
| `loud` | −10 | SoundCloud / Bandcamp / DJ pool (절대 라우드 필요 시) | (그 외 플랫폼에선 다이내믹 손실 후) | 모든 정규화 플랫폼 (대신 `balanced` 추천) |
| `kpop_loud` | −9 | K-Pop 차트 표준 (Melon / Spotify 한국) — 동종 곡과 음량 paired | SoundCloud | 라이브 / 클래식 / 재즈 |
| `punch` | −11 | Hip-Hop 차트 / 클럽 / SoundCloud | YouTube | acoustic / ballad |

**일반 권장**: 사용자가 "어떤 플랫폼에서 들을지" 를 명시하지 않으면 `balanced` (−12) 를 디폴트로 — 모든 플랫폼에서 큰 손실 없이 재생됨.

---

## 4. True-Peak 정책

| 플랫폼 | 권장 TP |
|---|---:|
| Spotify | **−1 dBTP** (lossy 코덱이 TP 를 살짝 키울 수 있음) |
| Apple Music | **−1 dBTP** (AAC 변환 마진) |
| YouTube Music | **−1 dBTP** |
| Tidal | **−1 dBTP** (Master 티어 lossless) |
| Tidal Master / MQA | **−2 dBTP** |
| 방송 (EBU/ATSC) | **−1 ~ −2 dBTP** strict |
| SoundCloud | **−1 dBTP** |
| 클럽 / 대형 PA | **−2 dBTP** (codec 변환 없음, 시스템 헤드룸 위해) |

**원칙**: Loui 의 모든 프리셋이 `ispSafety.ceilingDbtp ≤ −1.0` 을 기본값으로 가짐. KPOP loud 만 −0.8 (한국 차트 평균 마스터 관행 — 마진 더 좁음).

---

## 5. LRA (Loudness Range) 정책

Apple Music 의 "Sound Check" 는 정규화 후에도 LRA 가 너무 낮은 곡은 평탄해 들린다 (소리 크기는 비슷한데 다이내믹 죽음).

플랫폼별 LRA 권장 최저:

| 플랫폼 | LRA 최저 | 비고 |
|---|---:|---|
| Spotify | **3 LU** (이하 시 "compressed" 판정 가능) | |
| Apple Music | **4 LU** | Sound Check 정규화 결과가 더 평탄해짐 |
| YouTube Music | 4 LU | |
| 방송 | **5 LU** (EBU R128) | 다이내믹 보존 의무 |
| 클래식 / 재즈 / 라이브 | 10–14 LU | natural / acoustic 권장 |

→ 본 정책이 fixture metadata 의 `lraMinLu` / `lraMaxLu` 의 직접적 근거.

---

## 6. Codec 변환 (AAC / Opus / Vorbis) 의 영향

스트리밍 플랫폼은 거의 모두 lossy codec 으로 전송:

| 플랫폼 | 기본 codec | TP 마진 권장 |
|---|---|---|
| Spotify (free) | Ogg Vorbis 160 kbps | TP −1 충분 |
| Spotify (Premium) | Ogg Vorbis 320 kbps | TP −1 |
| Apple Music | AAC 256 kbps | TP −1 (AAC 가 TP 살짝 키움) |
| YouTube Music | AAC / Opus 128–256 kbps | TP −1 (Opus 가 IS peak 살짝 키움) |
| Tidal (HiFi) | FLAC | TP −1 |
| Tidal Master | MQA / FLAC | TP −2 (decoder 변환 마진) |

**결론**: TP −1 dBTP 가 모든 lossy codec 의 안전 마진. Master tier 만 −2 dBTP 권장.

---

## 7. 정규화 후 시뮬레이션 (M2 추가 예정 기능)

본 정책의 검증을 위해, M2 의 Rust dsp-core 에 **"정규화 후 시뮬레이션"** 모듈을 추가한다:

```
[input audio]
   ↓
[Loui mastering chain]
   ↓
[output WAV]
   ↓
[Platform Simulator]
   ├─ Spotify normalize (−14 LUFS, lossy AAC 256 회피 시뮬)
   ├─ Apple Music normalize (−16 LUFS)
   ├─ YouTube Music normalize (−14 LUFS)
   └─ SoundCloud (no normalize)
   ↓
[측정] LUFS / TP / 가청 라우드니스 추정
```

이로써 사용자가 "내 마스터가 Spotify 에서 어떻게 들릴지" 를 미리듣기 (preview-after-normalize) 할 수 있게 된다. M2 의 우선 기능 (`05-TARGET-ARCHITECTURE.md` 의 platform simulator) 와 연결.

---

## 8. 본 전략의 fixture / preset 적용

본 문서의 모든 수치는 다음 위치에 반영되어 있다:

- `app/fixtures/recipes/*.fixture.json` — `referenceMaster.targetMetrics.lufsI`, `tpMaxDb`, `lraMinLu/Max`
- `app/engine/builtin/*.preset.json` — `chain[loudness-norm].targetLufs`, `chain[limiter].ceilingDb`, `chain[isp-safety].ceilingDbtp`
- `tests/test_engine_preset_realmusic.py` — assertion thresholds

본 문서의 수치 변경은 위 3개 위치의 동시 갱신을 요구한다 (`01-DSP-POLICY-PHILOSOPHY.md` § 7 의 변경 절차 참조).

---

## 9. 사용자에게 노출되는 UI 메시지 (M3+)

향후 UI 에서 다음을 표시하도록 권장:

- **마스터 라우드니스 메터 옆에 "Spotify normalized: −14 LUFS" 표시**
- **프리셋 카드에 "best for: SoundCloud / Bandcamp" 같은 권장 플랫폼**
- **export 직전 "이 LUFS 는 Spotify 에서 X dB 깎입니다" 경고**

본 문서는 그 메시지의 콘텐츠 원천.
