# Windows 우선 출시 가이드 (Commercial Release)

목표: **Windows에서 첫 유료 고객을 받을 수 있는 상태**. macOS는 인증서 조달까지 보류.
검증 기준: 실제 코드 + CI(`.github/workflows/build.yml`).

---

## 1. Windows Release Checklist (P0)

| # | 항목 | 상태 | 비고 |
|---|---|---|---|
| 1 | NSIS 설치파일 생성 | ✅ 검증됨 | CI `build-win` → `electron-builder --win nsis --x64` → `Louver Mastering AI-Setup-<ver>.exe` |
| 2 | 엔진/FFmpeg 번들 | ✅ | PyInstaller `engine.exe` + `prebuild.cjs`가 ffmpeg/ffprobe를 `public/bin`→`extraResources`로 포함. 사용자 별도 설치 불필요 |
| 3 | 라이선스 백엔드 | ✅ | Supabase `aimaster-validate` 배포됨, 앱에 RemoteValidator 연결 |
| 4 | 페이월 | ✅ | 메인 프로세스에서 WAV/FLAC/AIFF 저장 차단(미결제), MP3 무료 |
| 5 | 구매 링크 | ✅(주입식) | `__PADDLE_CHECKOUT_URL__` (CI env `PADDLE_CHECKOUT_URL`). 미설정 시 fallback |
| 6 | 자동 업데이트(Win) | ⚠️ 동작/미서명 | NSIS+electron-updater 동작. SmartScreen 경고는 코드서명으로만 제거(P1) |
| 7 | 코드서명(Win) | ⛔ 미설정 | **출시 비차단**(경고 후 실행 가능). OV/EV 인증서로 후속 해소 |
| 8 | 키 자동전달 | ⛔ 수동 | 첫 100명은 수동 발송으로 진행(아래 6절) |
| 9 | CI 시크릿 주입 | ⛔ 운영자 | 프로덕션 보호 위해 아래 2절 시크릿 등록 필요 |

> **결론: 코드/패키징은 출시 가능. 운영자가 (A) CI 시크릿 등록 (B) Paddle 상품/체크아웃 URL (C) 키 수동 발송 절차만 갖추면 Windows 유료 판매 가능.**

### 출시 전 CI 시크릿 (GitHub → Settings → Secrets → Actions)
빌드 스텝 env로 전달되어야 실제 보호가 동작 (미설정 시 dev 모드 = 보호 없음):
- `LICENSE_API_URL` = `https://tyrhbiwvwmdybwaydvto.supabase.co`
- `LICENSE_API_KEY` = Supabase anon/publishable 키
- `LICENSE_HMAC_SECRET` = 16자+ 랜덤
- `PADDLE_CHECKOUT_URL` = Paddle 체크아웃 URL (renderer 빌드 env)

> ⚠️ 현재 `build.yml`의 빌드 스텝은 위 env를 아직 전달하지 않습니다. 프로덕션 보호 빌드를 원하면 `Build Electron app`(win) 스텝 env에 4개를 추가해야 합니다. (이 배선은 P0 발견 시 별도 수정 — 현재는 운영자 결정 대기.)

---

## 2. CI가 실제 NSIS 설치파일을 만드는가 — 검증 결과

`build-win` job (Windows runner) 순서:
1. Python venv + `pyinstaller==6.11.1` → `engine.exe` 생성(`public/bin`)
2. `node scripts/prebuild.cjs` → ffmpeg/ffprobe 복사
3. `pnpm build` (vite renderer + esbuild main)
4. 출력 존재 검증(`dist/renderer/index.html`, `dist-electron/main/index.js`)
5. `electron-builder --win nsis --x64 --publish <flag>` → **`out/Louver Mastering AI-Setup-<ver>.exe` + `latest.yml`**
6. `upload-artifact` (Actions UI에서 다운로드 가능)

`--publish` flag: 태그 `v*` push → `always`(릴리스 업로드), 그 외 → `never`(아티팩트만).
서명: `CSC_IDENTITY_AUTO_DISCOVERY:false` = 의도적 미서명.

✅ **NSIS 설치파일 생성은 검증됨.** (CI 히스토리상 `build-win` green)

---

## 3. Release Draft 생성 절차 (검증됨)

`release-draft` job은 **태그 `v*` push** 또는 **workflow_dispatch + release_tag 입력**일 때만 실행.

절차:
1. 버전 확정 (`apps/desktop/package.json` = `3.6.0`). 릴리스 노트는 `aimaster-desktop/docs/RELEASE_DRAFT_v3.6.0.md`(존재 확인됨; CI `body_path`가 이 파일을 참조 — 없으면 release job 실패).
2. 태그 푸시:
   ```bash
   git tag v3.6.0 && git push origin v3.6.0
   ```
3. CI: 3개 플랫폼 빌드(linux/mac/win 모두 성공해야 release-draft 트리거) → `softprops/action-gh-release`가 **draft + prerelease** 릴리스 생성, `*.exe`/`*.zip`/`*.AppImage`/`*.deb` 첨부.
4. 운영자가 GitHub Releases에서 draft 검토 → **Publish** 클릭.
5. Publish 후: 사용자 다운로드 가능 + electron-updater 클라이언트가 다음 체크에서 업데이트 감지.

주의:
- `needs:[build-linux,build-mac,build-win]` — **mac job이 실패하면 release 전체 실패.** mac은 미서명이지만 빌드 자체는 성공(green). 만약 mac 빌드가 깨지면 Windows-only 릴리스를 위해 `release-draft`의 needs/파일목록 조정 필요(현재는 3종 모두 요구).
- `fail_on_unmatched_files:true` — 첨부 glob에 매칭 파일 없으면 실패.

**Windows만 빠르게 배포하려면**: 정식 태그 릴리스 대신, `build-win` job의 **artifact(.exe)를 Actions UI에서 직접 다운로드**해 배포해도 됨(드래프트 publish 없이 첫 고객 대응 가능).

---

## 4. 전체 QA 시나리오 (실제 Windows 10/11에서 수동 검증)

> 코드 경로는 검증 완료(PASS). 아래는 **실기 Windows에서 사람이 한 번 통과**시켜야 하는 스모크 시나리오.

| 단계 | 동작 | 기대 결과 | 코드 근거 |
|---|---|---|---|
| 1. 설치 | `Setup.exe` 실행 | SmartScreen "추가 정보→실행" 후 설치, 단축키 생성 | NSIS oneClick:false |
| 2. 실행 | 앱 실행 | 메인 UI 표시(electronAPI 정상) | preload 노출 |
| 3. 업로드 | WAV 드래그/선택 | 큐에 추가, 분석 진행 | `file:open-dialog`, `audio:analyze` |
| 4. 마스터링 | 스타일 선택 → 시작 | 진행률 → 완료, 프리뷰 재생 | `audio:master` |
| 5. MP3 프리뷰 저장 | "프리뷰 MP3 저장" | **무료로 저장됨** | `file:save-wav`(mp3 = free) |
| 6. WAV 저장(미결제) | "마스터 WAV 저장" | **라이선스 모달 오픈**(차단) | 메인 페이월 `LICENSE_REQUIRED` |
| 7. 라이선스 활성화 | 키 입력 → 활성화 | 서버 검증 → pro 전환 | `license:activate` → RemoteValidator |
| 8. WAV 저장(결제후) | "마스터 WAV 저장" | **저장 성공** | 페이월 통과 |
| 9. 재시작 | 앱 재실행 | 라이선스 유지, 시작시 재검증 | `revalidate()` |
| 10. 오프라인 | 인터넷 끊고 마스터링/저장 | 정상 동작(라이선스 유지) | 오프라인 grace |

테스트용 키 발급(서버 검증 빌드):
```sql
insert into aimaster.license_keys (license_key, product, status, device_limit, email)
values ('AIMASTER-A1B2-C3D4-E5F6', 'lifetime', 'active', 2, 'qa@you.com');
```
Dev 빌드(`pnpm dev`)는 LocalValidator라 형식 맞는 아무 키나 활성화됨(UX 검증용).

---

## 5. Paddle Checkout URL 주입 구조 (구현 완료)

- 렌더러는 Vite `define`으로 `__PADDLE_CHECKOUT_URL__` 주입 (`vite.config.ts`).
- 빌드 시 env `PADDLE_CHECKOUT_URL` 사용, 미설정 시 fallback(`https://aimaster.io`).
- `LicenseModal.tsx`의 "구매하기" 링크가 이 값을 사용.
- CI: `Build Electron app`(win) 스텝 env에 `PADDLE_CHECKOUT_URL: ${{ secrets.PADDLE_CHECKOUT_URL }}` 추가하면 주입됨.

검증: 주입 시 번들에 URL 반영 확인, 미설정 시 fallback 확인.

---

## 6. 수동 키 발송 운영 절차 (첫 100명)

자동 이메일 전달은 미구현. 첫 판매는 수동으로 충분히 운영 가능.

### 결제 → 발송 흐름
1. 고객이 Paddle 체크아웃(공유 링크 또는 앱 내 "구매하기")에서 결제.
2. Paddle 웹훅(`aimaster-paddle-webhook`)이 `aimaster.license_keys`에 키 자동 생성(이메일 포함).
   - 웹훅 미연동 단계라면, 운영자가 직접 키 발급(아래 SQL).
3. 운영자가 신규 키 조회 → 고객 이메일로 발송.

### 신규 발급 키 조회 (Paddle 웹훅이 생성한 것)
```sql
select license_key, product, email, paddle_transaction_id, created_at
from aimaster.license_keys
where created_at > now() - interval '1 day'
order by created_at desc;
```

### 수동 발급 (웹훅 미사용/즉시 판매)
```sql
-- Lifetime
insert into aimaster.license_keys (license_key, product, status, device_limit, email)
values ('AIMASTER-XXXX-XXXX-XXXX', 'lifetime', 'active', 2, 'buyer@x.com');
-- Monthly (31일)
insert into aimaster.license_keys (license_key, product, status, device_limit, email, expires_at)
values ('AIMASTER-YYYY-YYYY-YYYY', 'monthly', 'active', 2, 'buyer@x.com', now() + interval '31 days');
```
> 키 형식 규칙: `AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}` (혼동문자 0/O/1/I 회피 권장).

### 환불/회수
```sql
update aimaster.license_keys set status='refunded' where license_key='AIMASTER-...';
-- 다음 앱 시작 시 revalidate()가 비활성 처리(온라인 시)
```

### 고객 발송 이메일 템플릿(예)
```
제목: [Louver Mastering AI] 라이선스 키 안내
본문:
구매해 주셔서 감사합니다. 아래 키를 앱의 라이선스 활성화 창에 입력해 주세요.

라이선스 키: AIMASTER-XXXX-XXXX-XXXX
플랜: 평생 라이선스 (기기 2대)

문의: support@(도메인)
```

---

## 부록: 알려진 비차단 항목
- Windows 코드서명 미설정 → SmartScreen 경고(실행 가능). OV/EV 인증서로 해소(P1).
- 앱 아이콘(`public/icon.ico`)이 placeholder 가능성 → 브랜드 아이콘 교체 권장(P2).
- FLAC/AIFF 저장은 메인 채널은 있으나 렌더러 UI 미연결(P1, WAV로 출시 비차단).
