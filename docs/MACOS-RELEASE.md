# macOS Release Candidate (Louver Mastering AI 데스크톱)

기존 Electron 데스크톱 앱의 macOS 배포(.dmg / .zip) 빌드·테스트 가이드.
범위: **데스크톱 앱만**. Android/Capacitor/서버 API·결제/계정/라이선스 변경 없음.

## 0. 현재 상태 (확인 완료)
- **CI 빌드 GREEN**: `.github/workflows/build.yml`의 `build-mac` 잡(`macos-14`, Apple
  Silicon 러너)이 우리 브랜치 push마다 실행되어 **성공**. 최신 run(`27600140020`,
  커밋 `d39be23`)에서:
  - "Package macOS .dmg + .zip (arm64 + x64)" = **성공**, zip 폴백 = **skipped**
    → **.dmg 패키징 정상**(과거 hdiutil 이슈 해소).
  - artifact **`Louver-Mastering-AI-mac`**(약 633 MB, 미만료) 업로드됨.
- 앱 식별: appId `com.louver.mastering`, **productName "Louver Mastering AI"**,
  버전 `3.6.0`, electron `28.3.3`.
- 아이콘: `apps/desktop/public/icon.png`. 카테고리 `public.app-category.music`.

## 1. 빌드 명령
### CI (권장)
- 우리 브랜치/`main`/태그 push 시 자동. 수동: Actions → "Build Louver Mastering AI"
  → Run workflow. 산출물은 run의 **Artifacts → `Louver-Mastering-AI-mac`**.

### 로컬 (macOS 필요)
```bash
# 사전: Python(엔진 PyInstaller), Node 20, pnpm 9
pnpm --filter @aimaster/desktop install
# 엔진/ffmpeg 번들 + 렌더러/메인 빌드 + dmg/zip 패키징
pnpm --filter @aimaster/desktop dist:mac      # → --mac zip --x64 --arm64
# dmg까지 원하면 electron-builder 직접:
pnpm --filter @aimaster/desktop exec electron-builder --mac dmg zip --x64 --arm64 --publish never
# 산출물: aimaster-desktop/apps/desktop/out/
```
> `dist:mac` 스크립트는 `scripts/prebuild.cjs`(ffmpeg-static/ffprobe → `public/bin`)
> + `pnpm build`(renderer+main) 후 electron-builder를 호출.

## 2. 산출물(아티팩트) 경로/파일명
`out/` 디렉토리:
| 파일 | 대상 | 용도 |
|---|---|---|
| `Louver Mastering AI-3.6.0-arm64.dmg` | Apple Silicon | 설치(드래그) |
| `Louver Mastering AI-3.6.0-x64.dmg` | Intel | 설치(드래그) |
| `Louver Mastering AI-3.6.0-mac-arm64.zip` | Apple Silicon | 압축/자동업데이트 |
| `Louver Mastering AI-3.6.0-mac-x64.zip` | Intel | 압축/자동업데이트 |
| `latest-mac.yml` | — | electron-updater 메타 |

다운로드: GitHub Actions의 해당 run → **Artifacts → `Louver-Mastering-AI-mac`** (zip 묶음)
→ 압축 해제 → 위 파일.

## 3. Apple Silicon / Intel 지원
- **둘 다 지원**: arm64(Apple Silicon) + x64(Intel) 별도 dmg/zip 생성.
- universal 바이너리는 사용 안 함(아키텍처별 분리 — 용량/안정성). 사용자 기기에 맞는
  arch 파일 설치.

## 4. 실행/테스트 절차 (실기 macOS)
1. 기기 arch 확인(  > 이 Mac에 관하여 → 칩: Apple M… = arm64 / Intel = x64).
2. 해당 `*.dmg` 열기 → 앱을 **Applications**로 드래그.
3. 첫 실행: **Gatekeeper 경고**(§7) → 우클릭 → 열기.
4. 기능 테스트(아래 §6) 수행.
- zip 사용 시: 압축 해제 → `.app`을 Applications로 이동 후 동일.

## 5. 검증 (개발자, 매 빌드)
- [x] `pnpm --filter @aimaster/desktop build` (renderer+main)
- [x] `pnpm --filter @aimaster/desktop typecheck`
- [x] CI `build-mac`: dmg+zip(arm64+x64) 생성 성공
- [ ] (macOS 실기) dmg 설치 → 실행 → Export 테스트

## 6. 기능 테스트 체크리스트 (실기)
| # | 항목 | 기대 |
|---|---|---|
| 1 | 앱 실행 | 크래시 없이 메인 화면 |
| 2 | 파일 선택 | 오디오 파일 다이얼로그 → 로드 |
| 3 | 마스터링 | 진행률 → 완료(엔진 동작) |
| 4 | 결과 재생/미리듣기 | 정상 |
| 5 | **WAV Export** | 저장 다이얼로그 → .wav 생성 |
| 6 | **FLAC Export** | .flac 생성 |
| 7 | **AIFF Export** | .aiff 생성 |
| 8 | **MP3 Export(무료)** | .mp3 생성 |
| 9 | **OGG Export(무료)** | .ogg 생성 |
| 10 | 번들 ffmpeg/engine | 외부 설치 없이 동작(public/bin) |
| 11 | 종료/재실행 | 상태 정상 |

> 무료/유료 Export 게이트는 기존 라이선스 로직 그대로(변경 금지). 무료 항목(MP3/OGG)은
> 라이선스 없이 가능해야 함.

## 7. Gatekeeper / 코드서명·공증 (서명 전후 차이)
현재 빌드는 **코드서명/공증 미적용**(`electron-builder.yml`에서 `mac.identity` 주석 처리).

| 항목 | 미서명(현재) | 서명+공증(향후) |
|---|---|---|
| 다운로드 후 첫 실행 | "확인되지 않은 개발자"/"손상됨" 경고 | 경고 없이 실행 |
| 실행 방법 | **우클릭 → 열기**(1회) 또는 `xattr -dr com.apple.quarantine "/Applications/Louver Mastering AI.app"` | 더블클릭 바로 실행 |
| 자동 업데이트(electron-updater) | **실패**("Could not get code signature…") | 정상 |
| 배포 적합성 | 내부/사이드로드 테스트용 | 공개 배포 가능 |

**공증 적용(향후, P1)**: Apple Developer 계정 → "Developer ID Application" 인증서 →
CI에 `CSC_LINK`(base64 .p12) + `CSC_KEY_PASSWORD`, 그리고 notarytool용
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 시크릿 추가 →
`electron-builder.yml`의 `mac.identity` 활성화 + `afterSign` 공증 훅. (별도 티켓)

테스터 안내 문구(미서명 동안):
> "처음 실행 시 앱 아이콘을 우클릭 → 열기 → 다시 열기를 누르세요. (서명 전 단계)"

## 8. 앱 아이콘 / 이름
- 이름: **Louver Mastering AI** (electron-builder productName).
- 아이콘: `public/icon.png`(전 플랫폼 공용). macOS는 빌드시 .icns 변환.
  - 고해상도 브랜드 아이콘 점검 권장(현재 png 4.5KB) — 공개 전 확인(P2).

## 9. 크래시 / 로그 위치 (macOS)
- 앱 로그: `~/Library/Logs/Louver Mastering AI/`
  (electron-log 기본 경로; main.log 등).
- 크래시 리포트: `~/Library/Logs/DiagnosticReports/Louver Mastering AI-*.crash`
  (또는 콘솔.app → "크래시 보고서").
- 앱 데이터/설정: `~/Library/Application Support/Louver Mastering AI/`.
- 콘솔 출력(개발): 터미널에서 `.app/Contents/MacOS/Louver\ Mastering\ AI` 직접 실행 시 stdout/stderr.

## 10. P0 / P1 (출시 차단/권장)
- **P0 (차단)**: 없음 — dmg/zip(arm64+x64) 빌드 성공, 실행 가능(우클릭 열기).
- **P1 (공개 전 권장)**:
  1. **코드서명 + 공증**(Gatekeeper 경고 제거 + macOS 자동업데이트 활성화).
  2. macOS **실기 회귀**: dmg 설치 → WAV/FLAC/AIFF/MP3/OGG Export 1회 완주(§6).
- **P2**: 고해상도 브랜드 아이콘 점검, universal 빌드 검토(선택).

## 11. 출시 가능 여부
- **내부/사이드로드 배포: 가능**(미서명, 우클릭 열기 안내 동반).
- **공개 배포/자동업데이트: 코드서명+공증(P1) 선행 필요.**
