# MIDI · 화성 · 보컬 피치 편집

작곡 영역으로 확장하기 위한 기반 레이어. Cubase 의 Key Editor / Chord Track /
VariAudio 에 해당하는 세 축을 **처음부터 MIDI 2.0 · MPE 를 담을 수 있는
데이터 모델** 위에 올렸습니다.

- 모델: `src/renderer/daw/model/` (`midi.ts` · `scales.ts` · `chords.ts`)
- 편집: `src/renderer/daw/edit/` (`midi-edit.ts` · `chord-detect.ts`)
- 파일: `src/renderer/daw/io/midi-file.ts`
- 보컬: `src/renderer/daw/audio/` (`pitch-analysis.ts` · `pitch-shift.ts` · `varia-actions.ts`)
- 엔진: `src/renderer/daw/engine/instruments.ts`
- UI: `src/renderer/components/daw/midi/`

## 1. 왜 이런 데이터 모델인가

프로토타입에서 흔한 `{pitch, velocity(0-127), cc[]}` 모델을 쓰지 않았습니다.
나중에 MIDI 2.0 / MPE 를 얹으려면 전 세션 마이그레이션이 필요해지기 때문입니다.

| 결정 | 이유 |
|---|---|
| 모든 연속값을 **정규화 실수**(0…1, 밴드는 −1…1)로 저장 | MIDI 1.0 의 7비트, 하이레졸루션 14비트, MIDI 2.0 의 32비트가 전부 손실 없이 들어옴. 전송 규격이 넓어져도 모델은 그대로 |
| 표현 데이터를 **노트 단위**로 저장 (`MidiNote.expression`) | MPE · MIDI 2.0 은 개별 노트를 지정함. 채널 단위 모델로는 표현 자체가 불가능 |
| 피치 = 정수 키 + **부호 있는 반음 오프셋** | 마이크로튜닝, MPE 벤드, 그리고 나중에 보컬→MIDI 전사의 실제 피치 곡선을 같은 필드로 받음 |
| 커브는 `{timeSec, value}` 브레이크포인트 | 해상도와 무관. 렌더러가 필요한 만큼 리샘플 |

`pitchBend` · `pressure` · `timbre` 는 MPE 의 세 축이자 MIDI 2.0 의 per-note
컨트롤러이고, 그 외는 `cc` / `registered` 로 받습니다.

## 가이드 멜로디로 피치 보정 (`toMidi`)

스케일에 맞추는 보정은 **"부른 음에서 가장 가까운 합법적인 음"** 만 물을 수
있습니다. 한 음 낮게 부른 프레이즈는 의도한 음이 아니라 **가까웠던 엉뚱한
스케일 음**으로 갑니다.

가이드 멜로디는 그 답을 미리 줍니다. Key Editor 에 MIDI 파트를 열어 두고
`Mod+Alt+T` 를 누르면, 각 VariAudio 구간이 그 순간 울리는 가이드 노트로
튜닝됩니다.

세부 셋이 결과를 좌우합니다.

* **겹침이 가장 큰 노트가 이깁니다.** 구간이 두 가이드 노트에 걸칠 수 있는데,
  먼저 시작한 노트를 고르면 길게 끈 음이 끝에서 만난 짧은 노트로 끌려갑니다.
* **3반음을 넘으면 건너뜁니다.** 부른 음에서 5도 떨어진 가이드 노트는 거의
  언제나 정렬 실수이지 아무도 원하지 않는 보정입니다. 안전 난간입니다.
* **가이드 노트가 없는 구간은 그대로 둡니다.** 프레이즈 사이에서 가수는 혼자
  두는 것이 맞지, 아무 데나 붙이는 것이 아닙니다.

가이드 파트는 타임라인의 다른 곳에 있어도 됩니다 — 노트는
`notesInClipTime()` 으로 오디오 클립의 시계로 옮겨진 뒤 비교됩니다. 고스트
노트와 같은 함수입니다.


## 2. Key Editor

`Mod+Alt+D` → DAW → **KEY** 탭, 또는 Edit 창에서 MIDI 파트를 더블클릭,
또는 파트를 가진 트랙을 선택하고 **Enter**.

편집 대상: Note · Velocity · Pitch(벤드) · Modulation · Expression ·
Aftertouch · CC · Quantize · Humanize · Scale.

| 영역 | 구현 |
|---|---|
| 노트 그리드 | 그리기 · 선택 · 드래그 이동 · 우측 끝 리사이즈 · 마퀴 선택 (한 제스처 = Undo 1회) |
| 스케일 가이드 | 스케일 밖 음은 어둡게. Snap Pitch Editing 으로 드래그가 스케일에 붙음 |
| 하단 레인 | Velocity / Pitch Bend / Aftertouch / Timbre(CC74) / Modulation / Expression / Sustain — 드래그로 직접 그림 |
| 노트 위 곡선 | 노트별 벤드 커브를 노트 안에 그려서 MPE 데이터가 보이지 않는 일이 없게 |
| 인포 라인 | Start · Length · Pitch · Velocity · Channel · 현재 코드 · 마우스 위치 |
| 인스펙터 | Scale Assistant · Chord Editing · Quantize · Humanize · Transpose · Length · Velocity |

### Quantize / Humanize

Quantize 는 그리드 · 튜플렛 · 스윙 · **강도(Soft Quantize)** · 캐치 레인지 ·
세이프 레인지 · 랜덤화 · 길이/엔드 퀀타이즈를 지원합니다.

Humanize 는 **시드 고정 난수**입니다. `Math.random()` 을 쓰면 오프라인
바운스가 방금 들은 것과 달라지므로, 같은 시드는 항상 같은 결과를 냅니다.
그루브 항목은 강박을 살짝 당기고 약박을 미는 편향을 넣어 "노이즈"가 아니라
"사람이 친 것"에 가깝게 만듭니다.

## 3. MIDI 파일 · 인스트루먼트

`Mod+Shift+I` 또는 DAW 툴바의 **MIDI 가져오기** 로 `.mid` 를 읽습니다.
포맷 0/1, 러닝 스테이터스, 템포 맵(리타르단도 포함), 박자표, 트랙명 지원.

**MPE 파일은 자동 감지**해서 채널별 벤드·프레셔·CC74 를 그 채널에서 울리는
노트의 per-note 표현으로 옮깁니다. 일반적인 임포터가 버리는 정보입니다.

내장 인스트루먼트는 Poly Synth(감산)와 E-Piano(FM) 두 종이며, **노트마다 보이스를
하나씩** 만듭니다. 그래야 벤드·프레셔·팀브르가 그 노트에만 걸립니다. 전부 네이티브
WebAudio 노드라 오프라인 바운스에서도 동일하게 렌더됩니다.

## 4. Chord Track

세션은 화성을 **구조화된 심볼**(근음 · 성질 · 베이스)로 들고 있습니다.
텍스트 라벨이 아니라 데이터이므로 변환이 함수입니다.

- 코드 감지: `Mod+Shift+C` — 열린 MIDI 파트를 마디 단위로 읽어 코드 트랙 생성
- 리하모나이즈: `Mod+Alt+J` — 3화음 → 7화음, 도미넌트 앞에 관련 ii 삽입
- 그 외 변환: 트라이톤 대리, 단순화, 이조, 코드→스케일 추천

```
Cmaj7 → Am7 → Dm7 → G7        (감지)
Cmaj7 → Am7 → Dm7 → Dm7 → G9  (extend + insertTwoFive)
Cmaj7 → Am7 → Dm7 → C#7       (tritone)
```

미래의 "여기 코드 좀 재즈스럽게 바꿔" 는 이 함수들을 호출하는 형태가 됩니다.
AI 가 오디오를 추측하는 게 아니라, 프로젝트가 이미 알고 있는 화성을
결정론적으로 변형하는 것이라 무엇이 바뀌었는지 항상 설명 가능합니다.

## 5. 보컬 피치 편집 (VariAudio 계열)

`Mod+Alt+P` 로 재생 위치의 오디오 클립을 분석하고, `Mod+Alt+U` 로 에디터
스케일에 맞춰 보정합니다. **원본 파일은 건드리지 않고** 새 렌더를 만들어
클립이 그것을 가리키게 하므로 Undo 로 완전히 되돌아갑니다.

측정하는 것 — 구간별로:

| 항목 | 방법 |
|---|---|
| Pitch | YIN (누적 평균 정규화 차분) + 포물선 보간 → 센트 단위 |
| Timing | 무성 구간 · 피치 도약 기준 세그먼테이션 |
| Vibrato | 드리프트를 뺀 곡선의 자기상관 → 4–8 Hz 대역의 속도 + 깊이(센트) |
| Pitch Drift | 센트 곡선의 최소자승 기울기 (센트/초) |
| Formant | 측정이 아니라 **편집 파라미터** (렌더에서 그레인 리샘플로 적용) |

편집 파라미터는 Cubase 의 스마트 컨트롤과 같은 축입니다:
`pitchOffsetCents` · `vibratoScale` · `driftScale` · `curveScale` ·
`formantSemitones` · `timeOffsetSec`.

렌더는 **TD-PSOLA** 입니다. 그레인의 파형(=성도 공명)을 그대로 두고 배치
간격만 바꾸므로 피치를 올려도 목소리가 다람쥐가 되지 않습니다. 포먼트는
그레인 **내용**을 리샘플해서 따로 움직입니다 — 두 축이 깨끗하게 분리됩니다.

```
피치   ← 합성 주기 (그레인 간격)
포먼트 ← 그레인 리샘플
타이밍 ← 어떤 분석 그레인을 참조하는가
```

## 6. 테스트

```
pnpm --filter @aimaster/desktop test:midi    # 모델 · 스케일 · 코드 · 편집 · SMF (41)
pnpm --filter @aimaster/desktop test:varia   # 피치 분석 · 편집 모델 · PSOLA 렌더 (20)
pnpm --filter @aimaster/desktop test:daw-engine  # MIDI 렌더 증명 포함 (17)
```

숫자로 검증하는 항목:
- 220 / 440 Hz 톤을 **10센트 이내**로 읽는가
- 5 Hz · 40센트 비브라토가 그대로 측정되는가
- +2 반음 편집이 실제로 장2도만큼 올라가는가 (렌더 후 재측정)
- 45센트 플랫한 노트가 목표 음정에 붙는가
- 편집하지 않은 구간이 **비트 단위로 동일**한가
- MPE 파일의 채널 벤드가 노트별 표현으로 옮겨지는가
- 노트별 벤드가 렌더된 오디오의 주파수를 실제로 바꾸는가 (Goertzel 측정)

## 7. 남은 작업

1. 보컬 편집 **UI** — 분석 결과를 파형 위에 세그먼트로 그리고 드래그로 피치·타이밍
   조정 (현재는 분석 · 보정 · 렌더가 명령/단축키로만 노출)
2. 노트 익스프레션 **기록** — 컨트롤러를 실시간으로 받아 커브로 저장
3. MIDI 내보내기의 MPE 모드 (현재 내보내기는 MIDI 1.0 채널 메시지)
4. 코드 트랙 편집 UI (현재는 감지 · 변환 · 표시)
5. 보컬 → MIDI 전사 (분석 결과가 이미 노트 후보라 연결만 남음)
