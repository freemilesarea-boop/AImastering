# 릴리스 리허설 체크리스트 (v* 태그 푸시 전)

목적: `v*` 태그를 실제로 푸시하기 **전에**, Guided Flow ON 릴리스 빌드가 안전하게 생성·설치·동작하는지 검증해 릴리스 실수를 줄인다.

- 코드 수정 금지 — **리허설 문서**. 각 항목 **PASS / FAIL / BLOCKED** 표기.
- 관련: `docs/GUIDED_FLOW_QA_CHECKLIST.md`, `docs/GUIDED_FLOW_ENABLE_PLAN.md`, `docs/WINDOWS-RELEASE.md`.
- 핵심 사실:
  - 태그(`v*`) 푸시 시에만 `VITE_LOUI_GUIDED_FLOW=true` + `AUTO_UPDATE_ENABLED=true` (build.yml).
  - 릴리스는 `release-draft` job이 **draft + prerelease**로 생성 → **수동 Publish 전까지 고객 비노출**(안전).
  - 현재 버전 `apps/desktop/package.json` = **3.6.0**, 릴리스 노트 `aimaster-desktop/docs/RELEASE_DRAFT_v3.6.0.md`(존재).
  - Windows = 미서명(SmartScreen 경고, 실행 가능). macOS = 미공증(실행/자동업데이트 제약 — 이번 검증은 **Windows 우선**).

---

## 1. 사전 조건

| ID | 항목 | 기대 | 결과 |
|---|---|---|---|
| 1-1 | 릴리스 대상 브랜치 최신 | `main`(또는 릴리스 브랜치) pull 최신, 머지 완료 | [ ] |
| 1-2 | QA 체크리스트 **P0 0건** | `GUIDED_FLOW_QA_CHECKLIST.md` 2~8절 PASS | [ ] |
| 1-3 | Guided Flow **OFF/ON 빌드 통과** | `build` / `VITE_LOUI_GUIDED_FLOW=true build` 둘 다 성공 | [ ] |
| 1-4 | typecheck | `pnpm --filter @aimaster/desktop typecheck` 0 에러 | [ ] |
| 1-5 | **License/Paddle 시크릿 준비** | GitHub Secrets: `LICENSE_API_URL`/`LICENSE_API_KEY`/`LICENSE_HMAC_SECRET`/`PADDLE_CHECKOUT_URL` 등록 여부 확인 | [ ] |
| 1-6 | 시크릿 미설정 시 영향 인지 | 미설정 = dev LocalValidator 번들(무보호) → **유료 배포는 반드시 설정** | [ ] |
| 1-7 | Windows installer 생성 가능 | `build-win` job 최근 green(NSIS `.exe` 산출 이력) | [ ] |
| 1-8 | 서명 정책 인지 | Windows 미서명(SmartScreen) — 출시 비차단으로 합의됨 | [ ] |

---

## 2. 로컬 리허설 (패키징 전, dev로 흐름 확인)

| ID | 동작 | 기대 | 결과 |
|---|---|---|---|
| 2-1 | `VITE_LOUI_GUIDED_FLOW=true pnpm --filter @aimaster/desktop dev` | 첫 화면 = 가이드 Import | [ ] |
| 2-2 | Import → Choose → Mastering → Result → Export 1회 완주 | 전 단계 정상, 크래시 0 | [ ] |
| 2-3 | **KPOP Loud + Strong + YouTube** 조합 | LUFS≈−9(불변), limiter high, True Peak 안전, "KPOP LOUD 완성" | [ ] |
| 2-4 | 무료 상태 **마스터 WAV 저장** | 차단 → LicenseModal 오픈 *(dev 바이패스 OFF 전제)* | [ ] |
| 2-5 | **MP3 프리뷰 저장** | 무료로 저장 성공 | [ ] |
| 2-6 | (대조) env 없이 `pnpm dev` | 첫 화면 = 레거시 HomePage(OFF 회귀) | [ ] |

> 2-4 주의: `NODE_ENV=development`/`AIMASTER_DEV_LICENSE=1`이면 페이월 무력화 → 바이패스 OFF로 검증(BLOCKED 처리 후 재시도).

---

## 3. CI 리허설 (태그 전, 비태그 빌드로 게이팅 확인)

| ID | 동작 | 기대 | 결과 |
|---|---|---|---|
| 3-1 | 현재 브랜치 push 또는 `workflow_dispatch`(release_tag 비움) 실행 | build-* job 실행, release-draft는 **skip** | [ ] |
| 3-2 | 비태그 빌드 = Guided Flow **OFF** 확인 | 산출 `.exe` 설치 시 첫 화면이 **레거시 Home** | [ ] |
| 3-3 | 비태그 빌드 아티팩트 다운로드 | Actions → 해당 run → Artifacts → `Louver-Mastering-AI-windows`(`.exe`,`latest.yml`) | [ ] |
| 3-4 | NSIS installer 확인 | 파일명 `Louver Mastering AI-Setup-3.6.0.exe` 존재 | [ ] |
| 3-5 | 태그 ON 확인 방법 숙지 | 태그 빌드 산출 `.exe` 설치 시 첫 화면이 **가이드 Import**여야 함(5·6절에서 확정) | [ ] |

> 게이팅 검증의 핵심: **같은 코드라도 비태그=OFF / 태그=ON**. 비태그 아티팩트로 OFF를 먼저 확인하면 태그 ON 결과의 대조군이 된다.

---

## 4. 태그 생성 전 체크

| ID | 항목 | 기대 | 결과 |
|---|---|---|---|
| 4-1 | version 확인 | `apps/desktop/package.json` = 의도한 버전(예: 3.6.0). 태그명과 일치(`v3.6.0`) | [ ] |
| 4-2 | release 노트 body 파일 | `aimaster-desktop/docs/RELEASE_DRAFT_v<ver>.md` 존재 + 내용 최신 (build.yml `body_path` 참조) | [ ] |
| 4-3 | changelog/주요 변경 정리 | Guided Flow ON 기본화 등 사용자 영향 명시 | [ ] |
| 4-4 | 브랜치 clean | `git status` 변경 없음, 미추적 없음 | [ ] |
| 4-5 | 마지막 커밋 hash 기록 | `git rev-parse HEAD` → 본 문서 하단에 기록(롤백 기준점) | [ ] |
| 4-6 | release-draft needs 인지 | linux/mac/win 빌드 **모두 성공해야** release-draft 트리거 | [ ] |

---

## 5. 태그 푸시 절차

```bash
# 0) 릴리스 대상 브랜치 최신화
git checkout main && git pull          # 또는 합의된 릴리스 브랜치

# 1) 클린 + 버전 확인
git status                              # clean 이어야 함
node -p "require('./aimaster-desktop/apps/desktop/package.json').version"

# 2) 태그 생성 + 푸시 (버전 일치)
git tag v3.6.0
git push origin v3.6.0
```

| ID | 확인 | 기대 | 결과 |
|---|---|---|---|
| 5-1 | GitHub Actions | 태그 트리거로 build-linux/mac/win + release-draft 실행 | [ ] |
| 5-2 | 빌드 env ON | 태그 빌드라 `VITE_LOUI_GUIDED_FLOW=true`, `AUTO_UPDATE_ENABLED=true` 적용 | [ ] |
| 5-3 | release-draft 생성 | **draft + prerelease** 릴리스 + `*.exe`/`*.zip`/`*.AppImage` 첨부 (아직 미공개) | [ ] |
| 5-4 | 아티팩트 다운로드 | draft 릴리스에서 Windows `Setup.exe` 받기 | [ ] |

> ⚠️ 태그 푸시는 **draft만** 만든다. 고객 노출은 **수동 Publish** 단계에서만 — 6절 통과 후 Publish.

---

## 6. 설치 검증 (깨끗한 Windows)

| ID | 동작 | 기대 | 결과 |
|---|---|---|---|
| 6-1 | 클린 Windows 10/11에 `Setup.exe` 설치 | SmartScreen "추가 정보→실행" 후 설치 완료, 단축키 생성 | [ ] |
| 6-2 | 첫 실행 | 정상 기동(화이트스크린 0) | [ ] |
| 6-3 | **Guided Flow 기본 표시** | 첫 화면 = 가이드 Import (태그 빌드 ON 확인) | [ ] |
| 6-4 | 실제 음원 마스터링 | Import→Choose→Mastering→Result 완주, +LU/LUFS/Waveform 정상 | [ ] |
| 6-5 | KPOP Loud 곡 | LUFS≈−9, True Peak 안전, 보컬 살아있음 | [ ] |
| 6-6 | Export | 무료=WAV 차단/모달, 활성화 후 WAV 저장, MP3 무료 (시크릿 설정 빌드 기준) | [ ] |
| 6-7 | 재실행 후 라이선스 유지 | 활성화 상태 보존, 시작 시 재검증 동작 | [ ] |
| 6-8 | 배치 모드 진입 | "배치 모드" → 레거시 Home 정상, "← 가이드 모드" 복귀 | [ ] |

> 6절 전부 PASS → release를 **Publish**. 그 전엔 draft 유지.

---

## 7. 실패 시 롤백

빠른 순:
1. **Publish 보류** — draft 상태면 고객 비노출이므로, 문제 발견 시 그냥 **Publish 안 함**(가장 안전).
2. **draft release 삭제** — GitHub Releases에서 해당 draft 삭제.
3. **태그 삭제** —
   ```bash
   git push origin :refs/tags/v3.6.0
   git tag -d v3.6.0
   ```
4. **Guided Flow OFF hotfix** — `build.yml`의 3개 `VITE_LOUI_GUIDED_FLOW`를 `'false'`로 변경 후 패치 태그(`v3.6.1`) 재빌드. (코드 로직 불변.)
5. **이전 installer 재배포** — 이미 공개된 이전 릴리스를 latest로 유지/복귀(신규 미공개 또는 unpublish). 자동 업데이트 클라이언트는 published latest만 받음.

롤백 트리거 = 8절 No-Go 또는 P0 발생.

---

## 8. Go / No-Go 기준

### ✅ Go (Publish 승인)
- 1~4절 사전/태그전 체크 전부 PASS
- 5절 빌드/ draft 정상 생성
- 6절 설치 검증 **전 항목 PASS**(특히 6-3 Guided ON, 6-6 페이월, 6-7 라이선스 유지)
- 실음원(발라드/AI/ KPOP) Result·Export PASS

### ⛔ No-Go (Publish 금지 / 롤백)
- 설치본 크래시/화이트스크린
- 첫 화면이 ON 의도와 다름(6-3 실패)
- 페이월 무력화(무료 WAV 저장됨) — 시크릿 설정 빌드에서
- Mastering/Result/Export 실패, 음질 파탄
- 배치/OFF 회귀 깨짐
- 라이선스 미유지(6-7)

### 처리 기준
- **P0**: Publish 차단 / 발생 시 7절 롤백 후 수정·재태그.
- **P1**: Publish 가능하나 차기 패치(시각 불일치, 안내 부족, 미서명 SmartScreen 안내 문구 등).
- **P2**: 출시 후 개선(디자인 폴리시, 텔레메트리, 데모 트랙, 파형 실데이터).

---

## 기록란
- 릴리스 버전 / 태그: __________
- 마지막 커밋 hash(4-5): __________
- 빌드 run URL: __________ / draft release URL: __________
- 검증자 / 일자: __________
- 최종 판정: ☐ Go(Publish) / ☐ No-Go(롤백) / ☐ 재검증
