# DAW 워크스페이스 (Pro Tools 구조 이식)

멀티트랙 Edit / Mix 워크스페이스. `Mod+Alt+D` 또는 우측 상단 **DAW** 버튼으로
들어갑니다.

핵심은 **하나의 세션 객체**입니다. Edit 윈도우와 Mix 윈도우는 같은
`DawSession`을 보는 두 개의 뷰이고, 오디오 엔진도 같은 객체를 읽어 그래프를
만듭니다. 그래서 페이더를 움직이면 다음 오디오 블록에서 바로 들리고,
Undo 한 번이 화면·소리·세션 파일을 동시에 되돌립니다.

## 레이어

| 레이어 | 위치 | 역할 |
|---|---|---|
| 모델 | `src/renderer/daw/model/` | 세션 데이터 + 순수 연산 (불변) |
| 편집 | `src/renderer/daw/edit/` | 클립 편집 verb, 트랜지언트, 컴핑, 탐색 |
| 엔진 | `src/renderer/daw/engine/` | WebAudio 그래프, 클립 스케줄러, 오프라인 렌더 |
| 상태 | `src/renderer/stores/dawStore.ts` | 세션 + 선택/재생헤드/그리드 + Undo |
| UI | `src/renderer/components/daw/edit·mix/` | Edit / Mix 윈도우 |

모델과 편집 레이어는 **DOM도 AudioContext도 모릅니다.** 그래서 전부 순수
함수로 테스트됩니다 (`test:daw`, 61 checks). 엔진은 실제
OfflineAudioContext로 렌더해서 검증합니다 (`test:daw-engine`, 12 checks).

## 신호 흐름 (채널 1개)

```
클립 (clip gain + fade)
  → 채널 입력
  → ADC 지연 (지연 보정)
  → 인서트 A…J
  → [프리 페이더 센드]
  → 페이더 (볼륨 × VCA × 뮤트/솔로)
  → 팬
  → [포스트 페이더 센드]
  → 출력 버스 / 마스터
```

버스는 합산 GainNode이고, `input`이 그 버스인 Aux 트랙이 리턴이 됩니다.
사이드체인 인서트는 버스 노드를 플러그인의 키 입력에 직접 물립니다.

## 가져온 요소별 구현 상태

| 요소 | 구현 | 비고 |
|---|---|---|
| Edit Window | ✅ | 파형 캔버스, 클립게인 라인, 페이드 곡선, 선택/재생헤드/루프, 클립 드래그 |
| Mix Window | ✅ | 인서트 A–E · 센드 A–E · I/O · 오토메이션 모드 · 그룹/VCA · 팬 · 페이더 · 미터 |
| Inserts | ✅ | 10슬롯. 내장 플러그인 6종(Trim / EQ3 / Comp / Look-ahead Limiter / Delay / Reverb) |
| Sends / Returns | ✅ | 슬롯 10개, 프리/포스트 전환, 레벨 · 팬 · 뮤트 |
| Bus | ✅ | 세션 레벨 버스 정의, 출력/센드 타깃 |
| Aux | ✅ | 버스를 입력으로 받는 트랙 = FX 리턴 / 패러렐 |
| Groups | ✅ | volume/mute/solo/pan 링크. 페이더 이동은 **상대값** (멤버 오프셋 보존) |
| VCA | ✅ | 중첩 가능, 뮤트 전파, 순환 참조 방어 |
| Clip Gain | ✅ | 페이더 이전 단, `Mod+Shift+↑/↓` 0.5 dB, 파형에 점선 표시 |
| Automation | ◑ | volume / pan / send level 레인 재생 + 6개 모드(off·read·touch·latch·write·trim) 로직 완비. **제스처 기록 UI와 레인 그리기는 미구현** |
| Playlist / Take | ✅ | 트랙당 N개 레인, 순환, 복제, 삭제 |
| Comping | ✅ | 다른 테이크의 선택 구간을 메인 플레이리스트로 (`Mod+Alt+V`) |
| Sidechain | ✅ | 네이티브 노드 디텍터 (|x| → 원폴 → 전달곡선 → GainNode.gain). 오프라인 렌더에서도 동작 |
| Pre / Post Fader | ✅ | 렌더 테스트로 증명 (프리 센드는 페이더를 내려도 살아있음) |
| Delay Compensation | ✅ | 플러그인이 지연의 단일 출처. 경로별 최대 지연에 맞춰 채널마다 DelayNode |
| Offline Bounce | ✅ | 세션/선택 구간 → WAV 24-bit. 라이선스 게이트는 기존 익스포트와 동일 |
| Freeze / Commit | ✅ | Freeze는 되돌릴 수 있고, Commit은 인서트를 오디오에 확정 |
| Session Import | ✅ | 다른 세션의 트랙 + 인서트/센드/오토메이션/파일, id 리맵 · 동명 버스 병합 |
| Tab to Transient | ✅ | 에너지 플럭스 온셋 탐지 + 클립 경계 병합. `Tab` / `Shift+Tab` |
| MIDI / Key Editor | ✅ | 별도 문서 — [MIDI.md](./MIDI.md) |
| Chord Track | ✅ | 구조화된 코드 심볼 + 감지 + 리하모나이즈 |
| 보컬 피치 편집 | ◑ | 분석 · 보정 · PSOLA 렌더 완료, 전용 UI 미구현 |

◑ = 로직은 있고 테스트도 되지만 UI 연결이 남음.

## 왜 플러그인을 네이티브 노드로만 만들었나

ScriptProcessor나 컨트롤 레이트 JS로 디텍터를 만들면
OfflineAudioContext 렌더에서 타이머가 돌지 않아 **바운스 결과가 실시간과
달라집니다.** 사이드체인 컴프와 룩어헤드 리미터의 디텍터를
`|x| → 원폴 → 전달 곡선 → GainNode.gain` 오디오 연결로 구성한 이유입니다.
덕분에 Bounce / Freeze / Commit이 실시간 그래프와 같은 코드로 렌더됩니다.

## 지연 보정의 단일 출처

인서트의 지연은 **플러그인이** 계산합니다
(`descriptor.latencyFor(params, sampleRate)`). 룩어헤드를 5 ms로 바꾸면
보정도 같이 따라갑니다. `Insert.latencySamples`는 표시용 캐시이자, 이 빌드에
없는 플러그인을 쓴 세션을 열었을 때의 폴백입니다.

## 테스트

```
pnpm --filter @aimaster/desktop test:daw          # 모델 · 편집 · 라우팅 · 컴핑 · IO (61)
pnpm --filter @aimaster/desktop test:daw-engine   # 실제 오프라인 렌더 증명 (12)
pnpm --filter @aimaster/desktop test:shortcuts    # 키보드 레이어 (34)
```

엔진 테스트가 실제로 측정하는 것: 클립 게인, 페이더, 뮤트, 솔로, 팬,
포스트/프리 페이더 센드, Aux 리턴 합산, 인서트와 바이패스, 사이드체인 더킹,
페이드 커브, **지연 보정 정렬**(같은 클릭이 두 경로에서 같은 샘플에 도착하는지).

## 남은 작업

1. 오토메이션 레인 그리기 + 페이더 제스처 기록(touch/latch)을 UI에 연결
2. 입력 녹음 (record arm은 모델에만 있음)
3. Spot 모드 다이얼로그 (Grid/Slip/Shuffle은 동작)
4. 플러그인 파라미터 편집 UI (현재는 인서트 선택 + 바이패스만)
