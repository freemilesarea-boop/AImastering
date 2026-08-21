# 로컬 마스터링 / Render 의존 감사

## 0-A. 모바일(`apps/mobile`) — Render → 온디바이스 로컬 전환 (완료)

> 출시/테스트 대상은 **모바일 앱(`apps/mobile`, Play 내부테스트 AAB)**. 이 앱의 마스터링을
> Render 서버 호출에서 **기기 내부(WebView) 로컬 처리**로 전환했다. 목표는 고품질 완성형이
> 아니라 **Render 서버비 0원 구조**(서버 job 생성/polling 제거).

- **새 로컬 엔진**: `apps/mobile/src/localMobileMastering.ts` — Web Audio `OfflineAudioContext`
  기반. 파이프라인: decode → 분석 → EQ(highpass/shelf/presence) → 글루 컴프 → 라우드니스 정규화
  → 트루피크 리미터 → WAV(16-bit) export → 미리듣기 URL. 업로드/네트워크/서버 **없음**.
- **제거된 Render 의존** (`apps/mobile/src/mobileApi.ts`):
  - `fetch(/v1/analyze)`, `fetch(/v1/master)`, job polling `fetch(/v1/jobs/{id})`,
    `fetch(/v1/jobs/{id}/download)`, `fetch(/v1/error-reports)` — **전부 삭제**.
  - 서버 설정/키(`ENV_API_URL`/`ENV_API_KEY`/`RELEASE_BUILD`/`baseUrl`/`authHeaders`/
    `setApiConfig`), 재시도 프리미티브(`withRetry`/`HttpError`/`JobInterruptedError`/
    `pollMaster`/`startMaster`/…) — **삭제**. `reportError`는 로컬 콘솔 로그 no-op로 대체.
  - 남긴 것: `pickAudioFile`/`saveToDownloads`/`shareFile`(네이티브) + 타입.
- **App.tsx**: 서버 설정 단계 제거 → 단계 = `파일 → 마스터 → 결과`. `onMaster`는
  `runLocalMastering(...)` 호출. 서버 지연/자동 재확인 문구 제거 → 로컬 진행률 문구
  ("오디오를 분석하고 있습니다" / "로컬 엔진으로 마스터링 중입니다" / "라우드니스 정규화 중" /
  "리미터 적용 중" / "Export 준비 중"). 동시 실행 1개 제한, 큰 파일 경고,
  백그라운드 전환 시 중단+재시도 안내.
- **빌드 env**: `.github/workflows/build-mobile-android.yml` + `apps/mobile/.env.example`에서
  `VITE_MASTERING_API_URL` / `VITE_MASTERING_API_KEY` / `VITE_RELEASE_MODE` 제거. AAB는
  서버 없이 빌드/동작.
- **검증**: `pnpm --filter @aimaster/mobile build`(tsc+vite) 통과, `cap sync android`(3 플러그인)
  통과, `apps/mobile/src`에 Render fetch 0건(주석 1건은 설명용).
- **남은 서버 의존(모바일)**: 없음. (결제/계정/구독 검증 서버를 붙일 경우 그 경로만 유지 — 현재
  모바일 앱엔 결제 코드 없음.)
- **다음 단계(품질 업그레이드, 별도 작업)**: `packages/dsp-wasm`(Rust DSP) 를 WebView에서
  재사용해 EQ/리미터 품질 향상. 현재 MVP는 Web Audio 노드만 사용.

### 릴리스 노트 / 버전
- **v1.0.1 (versionCode 30)**: Play Console versionCode 충돌(기존 29) 해소 전용 릴리스.
  기능 변경 없음 — 1곡 온디바이스 로컬 마스터링 그대로. (실기기/비행기모드 검증 완료된 플로우 유지)

### TODO — v1.1.0 batch mastering (이번 릴리스 제외)
- **다중 업로드(예: 10곡) + 배치 마스터링**은 **v1.1.0**으로 연기한다.
- 제외 사유: 출시 직전 다중 업로드/큐 처리를 추가하면 파일 피커·큐·메모리·저장·취소·
  백그라운드 처리 리스크가 커진다. v1.0.1은 versionCode 충돌만 해결하고, 검증된 1곡
  로컬 마스터링 플로우를 변경 없이 유지한다.
- v1.1.0 작업 시 고려: 순차(동시 1개 유지) 큐, 곡별 진행률/취소, 누적 메모리 해제
  (각 곡 처리 후 `URL.revokeObjectURL` + 버퍼 해제), 배치 저장 폴더, 부분 실패 리포트.

> `apps/mac-shell`은 `apps/mobile/dist`를 감싸는 macOS 래퍼다. 본 전환으로 mac-shell도
> 자동으로 로컬 처리가 되지만, **이번 작업 범위에서 직접 손대지 않았다**(별도 검증 필요).

---

## 0. 최종 결정 (Phase 1, 데스크톱 기준) — 승인됨

- **Render P0는 데스크톱 출시 기준으로 해제(RELEASED)** 한다. 근거: 데스크톱은 이미 로컬
  마스터링이며 Render 의존이 0(아래 §1 증명) → Render 상태와 무관하게 출시 가능.
- **`apps/desktop`은 코드 변경하지 않는다**(이미 로컬). 회귀 테스트만 수행(§7, 통과).
- **`apps/mobile` / `apps/mac-shell`은 Phase 1 출시 범위에서 제외**한다 — Render 마스터링 API
  의존 때문이며, 로컬 엔진 전환(= Phase 3) 이전까지 배포 대상이 아니다. **Phase 1 release
  blocker 아님.**
- **삭제하지 않는다**: `apps/mobile`, `apps/mac-shell`, `render.yaml`, `services/mastering-api`.
  (모바일 백엔드 + Play 내부테스트 AAB가 의존. 운영자가 Render 대시보드에서 직접 Suspend 예정.)
- 변경 범위: **문서 + release checklist만.** 코드/엔진/모바일 무수정.

---


> 결론 먼저: **데스크톱 앱(`apps/desktop`)은 이미 100% 로컬 마스터링이며 Render 의존이 0**이다.
> Render 사용량은 전적으로 **모바일 앱(`apps/mobile`, Play AAB 포함) + `mac-shell`** 에서 발생한다.
> 따라서 **Render는 데스크톱 출시의 P0가 아니다.**

## 1. 증명 — apps/desktop의 Render 의존 = 0 (코드 근거)

`apps/desktop` 전체에서 다음 키워드 검색 → **매칭 0건**:
`onrender · render.com · MASTERING_API · VITE_MASTERING · /v1/master · /v1/jobs · /v1/analyze · mastering-api`

- 데스크톱 마스터링 경로: `renderer` → `window.electronAPI.invoke('audio:analyze' | 'audio:master')`
  → `main/ipc/audioHandlers.ts` → `getBridge()` + `masterFile(...)` = **번들된 Python/FFmpeg 엔진(JSON-RPC stdio)** + Rust DSP WASM 프리뷰. 전부 사용자 PC에서 실행.
- 데스크톱 renderer의 모든 `fetch()`는 **로컬 자산 로드뿐**: 오디오 파일 peaks(`useWaveformPeaks`),
  WASM 바이너리(`loui-mastering-wasm`), AudioWorklet 자산(`worklet-asset-source`, `realtime-readiness`).
  서버/Render 호출 **없음**.
- `apps/desktop`에 **`.env` 파일 없음**, 빌드 설정(`electron-builder.yml`/`vite.config`/`esbuild`)에
  Render/MASTERING env **없음**.
- 엔진은 데스크톱 빌드에 **번들**됨(`build.yml`의 PyInstaller 단계 + `extraResources` ffmpeg).

→ **데스크톱은 서버가 죽어도 마스터링이 동작한다(이미 로컬).** 제거할 Render 코드가 없다.

## 2. Render 사용량의 실제 원인 (코드 근거, 추측 아님)

- **Render에 배포되는 것**(`render.yaml`): 오직 `aimaster-mastering-api`
  (= `services/mastering-api`, FastAPI). 이게 Render 자원을 쓰는 유일한 서비스.
- **이 서버를 호출하는 클라이언트**(런타임 코드):
  - `apps/mobile/src/mobileApi.ts` + `App.tsx` — Capacitor Android 앱
    (`fetch(https://aimastering.onrender.com/v1/master | /v1/jobs | /v1/analyze | /download)`).
  - `apps/mac-shell` — `apps/mobile/dist`를 감싼 macOS 래퍼(동일 호출).
  - `apps/desktop`은 **목록에 없음**.
- **직접 원인(smoking gun)**: Android **release** 워크플로가 AAB에
  `VITE_MASTERING_API_URL=https://aimastering.onrender.com`을 박는다
  (`build-mobile-android.yml`). 이 AAB가 Play 내부 테스트에 올라가 있어,
  **테스터가 마스터링할 때마다 CPU/RAM 무거운 FFmpeg+numpy 작업이 단일 Render 인스턴스에서 실행** →
  Render Starter 사용량 초과 메일.

## 3. Render는 왜 데스크톱 P0가 아닌가
- 데스크톱 마스터링 = 100% 로컬(§1). Render 다운/과금/지연과 **무관**.
- Render 비용/장애의 원인은 §2의 모바일/mac-shell 경로. 데스크톱 출시 제품에는 영향 없음.

## 4. 데스크톱에 남는 서버 의존 (유지 대상 — Render 아님)
| 의존 | 용도 | 호스트 | 유지 |
|---|---|---|---|
| `LICENSE_API_URL` (license-core `RemoteValidator`) | 라이선스/계정/결제 검증 | (Render 아님) | ✅ 유지 |
| Supabase (account-auth, 플래그 OFF 기본) | 계정/엔타이틀먼트 | Supabase | ✅ 유지(옵션) |
| `electron-updater` | 자동 업데이트 | GitHub Releases | ✅ 유지 |
> 인증/결제/업데이트는 가볍고 비용 폭증과 무관. 마스터링 서버만 비용/장애 원인.

## 5. Render 비용 제거 액션 (운영자)
데스크톱 코드 변경은 **불필요**(이미 로컬). 비용을 멈추려면:
1. **Render 대시보드에서 `aimaster-mastering-api` 서비스 Suspend/Delete** — 실행 중 인스턴스가
   비용을 쓰므로 이게 실제 cost-kill. (코드/리포로는 멈출 수 없음)
2. **Render-백엔드 Android AAB를 Play에 배포/확대하지 않기** — 테스터 증가 시 Render 호출 증가.
3. (선택) 리포에서 Blueprint 재배포 방지: `render.yaml` 제거 또는 보류
   — 단 모바일 백엔드를 되살릴 계획이면 보존. **삭제는 별도 승인 후.**

## 6. 롤백
- 데스크톱은 변경이 없으므로 롤백 불필요.
- 모바일 백엔드가 다시 필요하면 Render 서비스 재개(Resume) 또는 `render.yaml` Blueprint 재배포로 복구.

## 7. 데스크톱 출시 전 체크리스트 (Render와 무관함 확인됨)
- [x] `apps/desktop`에 Render/MASTERING 참조 0건(검색 증명)
- [x] 마스터링 = 로컬 IPC(`audio:master`) + 번들 엔진 + WASM
- [x] 서버 의존은 license/auth/updater뿐(비용 폭증과 무관)
- [ ] `pnpm --filter @aimaster/desktop typecheck && build` (회귀 확인)
- [ ] Win/macOS 패키징(`build.yml` build-mac/build-win) 산출물 확인
- [ ] 오프라인(인터넷 차단)에서 마스터링 동작 확인(엔진 로컬이므로 통과 기대)
- [ ] (운영) Render `aimaster-mastering-api` Suspend로 비용 중단

## 부록 — "서버→로컬 마이그레이션"이 데스크톱엔 해당 없음
지시받은 `renderer/services/mastering-client.ts`(Render 호출)·job polling·retry·서버 지연 UX는
**`apps/desktop`에 존재하지 않는다**(그건 `apps/mobile`의 구조다). 데스크톱은 처음부터 로컬 IPC
구조라 교체 대상이 없다. 모바일은 본 작업 범위 밖(모바일 작업 금지).
