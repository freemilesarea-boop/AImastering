# MacBook 로컬 QA — Guided Flow (dev 모드)

목적: MacBook 개발 모드에서 `VITE_LOUI_GUIDED_FLOW=true pnpm dev`로
**Import → Choose → Mastering → Result → Export** 흐름을 검증.
Windows 설치 검증은 9절(GitHub Actions 산출물 확인)로 분리. macOS 서명/공증은 범위 외.

> 아래 명령을 **위에서부터 순서대로** 복붙. `~/work/AImastering`는 본인 클론 경로로 바꿀 것.

---

## 1. 도구 설치 (최초 1회)

```bash
# Homebrew 도구
brew install node ffmpeg python@3.11

# pnpm 9
npm install -g pnpm@9

# 버전 확인 (node ≥ 20, python ≥ 3.10, ffmpeg present, pnpm ≥ 9)
node -v && python3 --version && ffmpeg -version | head -1 && pnpm -v
```

---

## 2. 의존성 + Python 엔진 셋업 (최초 1회)

```bash
cd ~/work/AImastering/aimaster-desktop

# Node 의존성
pnpm install

# Python 엔진 venv (dev 마스터링이 실제로 돌려면 필요: soundfile + numpy)
python3 -m venv services/python-audio/.venv
services/python-audio/.venv/bin/pip install -U pip -q
services/python-audio/.venv/bin/pip install -r services/python-audio/requirements.txt -q

# dev 엔진이 이 venv를 쓰도록 경로 확인 (다음 절에서 export)
echo "$PWD/services/python-audio/.venv/bin/python"
```

> dev 모드는 `AIMASTER_PYTHON`(미설정 시 시스템 `python3`) + 소스 `services/python-audio/app/main.py`를 사용. FFmpeg는 `AIMASTER_FFMPEG` 없으면 **PATH의 ffmpeg**로 폴백 → brew ffmpeg면 충분.

---

## 3. dev 실행 (Guided Flow ON)

```bash
cd ~/work/AImastering/aimaster-desktop

# 같은 셸에서 export → electron main이 상속
export AIMASTER_PYTHON="$PWD/services/python-audio/.venv/bin/python"

# 페이월을 테스트하려면 dev 라이선스 바이패스가 꺼져 있어야 함:
unset NODE_ENV
unset AIMASTER_DEV_LICENSE

# Guided Flow ON 으로 dev 실행 (Vite + esbuild watch + Electron)
VITE_LOUI_GUIDED_FLOW=true pnpm --filter @aimaster/desktop dev
```

확인:
- [ ] Electron 창이 뜬다
- [ ] **첫 화면 = 가이드 Import**("트랙을 올리면, 마스터가 됩니다." + 큰 드롭존). 큐/배치 UI가 아니어야 함

> 만약 첫 화면이 레거시 Home이면: DevTools(⌥⌘I) 콘솔에서
> `window.__LOUI_GUIDED_FLOW__ = true` 입력 후 `location.reload()`.

---

## 4. 검증: Import

```text
(앱 화면에서 직접 동작)
```
- [ ] 드롭존 **클릭** → 파일 다이얼로그에서 WAV 선택 → Choose 화면 이동
- [ ] 오디오 파일을 드롭존에 **드래그앤드롭** → Choose 이동
- [ ] `.txt` 같은 비오디오 드롭 → 무시(이동 안 함, 크래시 없음)
- [ ] Choose에서 "← 파일 다시 선택" → Import 복귀

DevTools 콘솔로 선택 상태 확인:
```js
// 선택된 파일 경로 확인
window.electronAPI && console.log('selected:', /* Choose로 넘어갔으면 set 됨 */ true)
```

---

## 5. 검증: Choose (세 가지)

- [ ] Style 미선택 → 시작 버튼 비활성("스타일을 선택하세요")
- [ ] **KPOP LOUD** 선택 → 시그니처 그라데이션/뱃지 + 시작 버튼 KPOP 액센트
- [ ] Intensity **Strong** 선택
- [ ] Target **YouTube** 선택
- [ ] "마스터링 시작" → Mastering 화면 이동

options 매핑 즉석 확인 (DevTools 콘솔, 시작 직전):
```js
// zustand store 직접 조회 (renderer)
// KPOP Loud + Strong 기대: targetLufs=-9, targetTp=-0.8, limiterStrength='high'
// (Balanced+Strong+Apple 기대: targetLufs=-15, limiterStrength='high')
```
> store 인스턴스가 전역에 없으면, Result 화면의 "마스터 LUFS"가 기대 targetLufs 근처인지로 간접 확인.

---

## 6. 검증: Mastering

- [ ] 진행률 링 0%→증가, `%` 표시
- [ ] 단계 텍스트: 분석 → 톤 보정 → 음압 강화 → 트루피크 보호
- [ ] KPOP Loud 진입 시 링/게이지 **KPOP 시그니처 색**
- [ ] "취소" → 중단/복귀(크래시 없음)
- [ ] 정상 완료 → **Result 자동 이동**

엔진이 안 돌면(아래 10절 트러블슈팅) — 보통 `AIMASTER_PYTHON` 미설정 또는 ffmpeg PATH 문제.

---

## 7. 검증: Result + Export

- [ ] 상단 **+X.X LU** 카운트업 (마스터−원본 실측)
- [ ] "KPOP LOUD 완성" 뱃지 + 시그니처 색
- [ ] Loudness 바(원본/마스터) + 목표 점선, 실수치
- [ ] Waveform(원본 얇음 → 마스터 꽉 참)
- [ ] A/B 비교/재생 동작
- [ ] **MP3 프리뷰 저장** → 무료로 저장 성공
- [ ] "다시 마스터링" / "새 파일" 동작

---

## 8. 검증: Paywall (dev 바이패스 OFF 상태)

먼저 라이선스 상태 확인 (DevTools 콘솔):
```js
await window.electronAPI.invoke('license:status')
// 기대: { tier: 'free', canSaveMasterWav: false, ... }
// 만약 tier:'pro'/canSaveMasterWav:true 면 dev 바이패스가 켜진 것 →
// 터미널에서 unset NODE_ENV / unset AIMASTER_DEV_LICENSE 후 dev 재실행
```

- [ ] 무료 상태에서 **마스터 WAV 저장** → 차단 + LicenseModal 오픈
- [ ] 모달에 키 입력 → 활성화 (dev는 LocalValidator: 형식만 맞으면 통과)
  - 키 예시: `AIMASTER-AAAA-BBBB-CCCC`
- [ ] 활성화 후 **마스터 WAV 저장** → 저장 성공
- [ ] (선택) 활성화 상태 확인:
```js
await window.electronAPI.invoke('license:status')   // tier: 'pro'
// 원복: 
await window.electronAPI.invoke('license:deactivate')
```

---

## 9. OFF 대조 + 배치 회귀 (선택)

```bash
# 플래그 없이 실행 → 레거시 Home 확인
cd ~/work/AImastering/aimaster-desktop
export AIMASTER_PYTHON="$PWD/services/python-audio/.venv/bin/python"
pnpm --filter @aimaster/desktop dev
```
- [ ] 첫 화면 = **레거시 HomePage**(큐/배치 UI)
- [ ] 기존 Import→Mastering→Result 정상
- [ ] (ON 빌드에서) Import 하단 "배치 모드" → 레거시 Home → "← 가이드 모드" 복귀

---

## 10. Windows installer 검증 (분리 — GitHub Actions 산출물)

> MacBook에선 설치 불가. 아래로 **CI 산출물만 확인**.

```bash
# (옵션) gh CLI 사용 시 — 비태그 빌드 트리거해 OFF 아티팩트 확인
gh workflow run "Build Louver Mastering AI"            # workflow_dispatch (release_tag 비움)
gh run list --workflow "Build Louver Mastering AI" -L 5
# 완료 후 Windows 아티팩트 다운로드
gh run download <run-id> -n Louver-Mastering-AI-windows -D ./win-artifact
ls -lh ./win-artifact   # 기대: "Louver Mastering AI-Setup-3.6.0.exe" + latest.yml
```
- [ ] 비태그(`workflow_dispatch`) 빌드 = Guided Flow **OFF** (`VITE_LOUI_GUIDED_FLOW=false`)
- [ ] 태그(`v*`) 빌드 = Guided Flow **ON** — 실제 설치 검증은 Windows 보유자/리허설 체크리스트(`RELEASE_REHEARSAL_CHECKLIST.md` 6절)에서.
- [ ] `.exe` + `latest.yml` 산출 확인

> gh CLI 없으면: GitHub → Actions → 해당 run → Artifacts에서 수동 다운로드.

---

## 11. 트러블슈팅 (자주 나는 것)

| 증상 | 원인 | 해결 |
|---|---|---|
| Mastering이 바로 실패(engine 오류) | `AIMASTER_PYTHON` 미설정 / venv 없음 | 2절 venv 재설치 + 3절 `export AIMASTER_PYTHON=...` 같은 셸에서 |
| "ffmpeg not found" 류 | ffmpeg PATH 없음 | `brew install ffmpeg`, `which ffmpeg` 확인 |
| 첫 화면이 흰 화면 | preload/렌더러 빌드 문제 | DevTools 콘솔 에러 확인, `pnpm install` 재실행, dev 재시작 |
| 첫 화면이 레거시 Home | 플래그 미주입 | `VITE_LOUI_GUIDED_FLOW=true` 접두 확인 또는 콘솔 `window.__LOUI_GUIDED_FLOW__=true`+reload |
| 페이월이 안 잡힘(무료인데 WAV 저장됨) | dev 라이선스 바이패스 ON | `unset NODE_ENV AIMASTER_DEV_LICENSE` 후 재실행, `license:status`로 free 확인 |
| 한글/공백 경로에서 실패 | 경로 인코딩 | 영문/공백없는 폴더의 파일로 시도 |

---

## 판정란
- 실행 커밋 hash: `git -C ~/work/AImastering rev-parse HEAD`
- 4~8절 결과: PASS / FAIL / BLOCKED
- 최종: ☐ 로컬 dev QA 통과(→ Windows 리허설 진행) / ☐ P0 수정 필요
