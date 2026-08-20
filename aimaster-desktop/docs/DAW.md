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

## DAW 안에서는 DAW 밖으로 나가지 않는다

DAW 는 몰입하는 창입니다. 세션 안에서 한 행동이 사용자를 홈 화면으로 내보내면,
그건 기능이 아니라 사고입니다.

파일이 어디로 갈지는 **지금 보고 있는 창**이 정합니다 (`daw/model/drop-target.ts`
— 순수 함수라 DataTransfer 없이 테스트합니다).

| 지금 창 | 오디오 | MIDI | 페이지 이동 |
|---|---|---|---|
| DAW | 플레이헤드 위치에 트랙으로 | 파트로 (Key Editor 자동 오픈) | **없음** |
| 그 외 | 마스터링 대기열 (최대 20) | 건너뜀 | 홈으로 |

대기열은 상한이 있으니 넘친 파일을 세어서 알려줍니다. 세션은 작업 공간이므로
상한이 없습니다 — 30트랙을 끌어다 놓는 건 실수가 아니라 결정입니다.

드래그 오버레이 문구도 목적지를 말합니다: DAW 안에서는 "세션에 트랙으로
추가합니다".

가져오기 경로는 하나입니다 (`daw/edit/session-import.ts`). 툴바 버튼 · 드래그
앤드 드롭 · `Mod+O` 가 전부 같은 함수를 지나므로, 어떻게 요청했든 "가져오기"의
뜻이 같고 언두 스택에도 똑같이 남습니다.

## 디코딩은 렌더러가 하지 않는다

렌더러는 `decodeAudioData` 를 부르지 않습니다. 크로미움 네이티브 코드이고,
macOS 에서 실제 곡을 넣으면 렌더러 프로세스를 **SIGSEGV** 로 데려갑니다.

```
[audio-cache] decode 31.6MB — I Like You.wav
[CRASH] render-process-gone reason=crashed exit=11
```

잡을 수 있는 예외가 아닙니다. 창에는 `backgroundColor` 만 남고, 보고할
프로세스가 이미 없으므로 에러도 안 나옵니다 — **검은 화면**의 정체입니다.
자기가 부른 호출 안에서 프로세스가 죽는 것을 렌더러가 방어할 방법은 없습니다.

그래서 디코딩을 렌더러 밖으로 옮겼습니다.

```
메인 프로세스               렌더러
ffprobe  → 채널 · 길이
ffmpeg   → f32le raw   ──►  createBuffer + copyToChannel
                            (그냥 메모리 복사 — 폴트 날 수 없다)
```

`daw:decode-pcm` IPC 하나입니다. ffmpeg 가 죽으면 IPC 하나가 reject 되고 앱이
그걸 말해줄 뿐, 창은 그대로 살아 있습니다. 덤으로 크로미움이 못 읽는 포맷도
전부 열립니다.

`decodeAudioData` 폴백은 `window.electronAPI` 자체가 없는 환경 — Node
셀프테스트 — 전용으로만 남아 있습니다.

브레드크럼(`decode → analyze → done`)은 그대로 둡니다. 네이티브 코드가
프로세스를 데려가면 스택이 남지 않으므로, 터미널의 마지막 줄이 어느 단계 ·
어느 파일이었는지 말해주는 유일한 기록입니다 (dev 에서만 출력).

## 디코딩 컨텍스트 — 절대 오프라인 컨텍스트로 디코딩하지 말 것

`decodeAudioData` 는 **실행 중인** 컨텍스트를 요구하지 않습니다. 크로미움이
별도 스레드에서 디코딩해 AudioBuffer 를 넘겨주므로 suspended 상태의
`AudioContext` 로 충분하고, 사용자 제스처도 필요 없습니다.

그런데 DAW 는 한때 `new OfflineAudioContext(1, 1, 48000)` — 프레임 하나짜리
오프라인 컨텍스트 — 로 디코딩했습니다. 앱 전체에서 여기 한 곳뿐이었습니다.
이걸로 실제 곡을 디코딩하면 macOS 에서 렌더러 프로세스가 **SIGSEGV
(`reason=crashed exit=11`)** 로 죽습니다. 이건 잡을 수 있는 예외가 아닙니다 —
창에는 `backgroundColor` 만 남고, 보고할 프로세스가 이미 없으므로 에러도
나오지 않습니다.

같은 파일 · 같은 `fetch` · 같은 `decodeAudioData` 를 쓰는 마스터링 화면
(`useWaveformPeaks`)은 **라이브 AudioContext** 로 디코딩하고 한 번도 죽은 적이
없습니다. 차이는 컨텍스트 종류 하나뿐이었습니다.

지금은 `audio/decode-context.ts` 하나가 앱 전체의 디코딩 컨텍스트를 들고 있고,
DAW 와 마스터링 화면이 그걸 공유합니다. 라이브 컨텍스트가 있으면 **항상**
그쪽이 이깁니다. 오프라인 폴백은 `AudioContext` 자체가 없는 Node 셀프테스트
전용입니다.

`loadAudio()` 는 단계마다 `console.info` 브레드크럼을 남깁니다
(`fetch → decode → analyze → done`). 네이티브 코드가 프로세스를 데려가면
스택이 남지 않으므로, 터미널의 **마지막 줄**이 어느 단계 · 어느 파일에서
죽었는지 말해주는 유일한 기록입니다. dev 에서만 터미널로 올라옵니다.

## 디코딩 메모리 — 지켜야 하는 규칙

48 kHz 스테레오 5분 곡 하나가 디코딩되면 **float32로 약 115 MB**입니다.
홈 큐는 최대 20곡이므로, 전부 한꺼번에 디코딩하면 2 GB가 넘는 요청이 한 번에
들어가고 렌더러 프로세스가 죽습니다. 렌더러가 죽으면 창은 자기
`backgroundColor`(`#09090b`)만 남습니다 — **에러 메시지 없는 검은 화면**의
정체가 이것입니다. 보고할 렌더러가 이미 없기 때문입니다.

`audio-cache.ts`가 강제하는 두 가지:

1. **디코딩은 순차적이다.** `decodeForDisplay` · `preloadAll` 은 한 번에 한
   파일만 처리합니다. `Promise.all(files.map(loadAudio))` 은 금지 — 최대 메모리가
   "캐시 + 한 곡"이 아니라 "세션 전체"가 됩니다.
2. **캐시 한도는 개수가 아니라 바이트다.** 5분짜리 12곡과 8마디 루프 12개는
   같은 개수이고 메모리는 100배 차이입니다 (`MAX_CACHE_BYTES` = 700 MB,
   `evictionPlan()` 이 순수 함수로 규칙을 들고 있습니다).

버퍼가 밀려나도 **피크 엔벨로프와 온셋 마크는 남습니다**(`getMeta`). 파형은
계속 그려지고 Tab to Transient도 그대로 동작하며, 샘플이 다시 필요해지는
순간에만 재디코딩합니다.

## 테스트

```
pnpm --filter @aimaster/desktop test:daw          # 모델 · 편집 · 라우팅 · 컴핑 · IO (67)
pnpm --filter @aimaster/desktop test:daw-engine   # 실제 오프라인 렌더 증명 (25)
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
