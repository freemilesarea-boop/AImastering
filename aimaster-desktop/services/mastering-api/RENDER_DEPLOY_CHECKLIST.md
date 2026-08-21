# Render 배포 최종 점검 — M0 Mastering API

모바일 앱이 호출 가능한 형태로 M0 서버를 Render에 올리기 위한 체크리스트 ·
env 표 · 배포 후 curl 테스트 · **앱에 URL/KEY 넣는 법** · 무료 vs starter ·
파일 권장값. (정적 검증 완료 기준)

> 범위: 배포 설정만. 엔진 로직 · 모바일 기능 · 결제/계정 · 데스크톱은 건드리지 않음.

## 확정 결정 (운영)
1. **Render plan = `starter`(유료) 유지** — 배포 가능성/안정성 우선.
2. **ffmpeg = 현재 Dockerfile의 apt ffmpeg(Debian 5.x) 유지.**
3. ffmpeg-static 7.0.2 고정은 **테스트 중 음질/출력 차이가 확인될 때만** 별도 이슈로 처리.
4. 지금은 **배포 가능성 우선**.

---

## 1. 배포 전 체크리스트 (정적 검증 결과)
| # | 항목 | 상태 | 근거 |
|---|---|---|---|
| 1 | `render.yaml` 경로 | ✅ | 리포 루트 기준: `dockerfilePath: aimaster-desktop/services/mastering-api/Dockerfile` |
| 2 | Dockerfile build context | ✅ | `dockerContext: aimaster-desktop`(리포 루트 상대) → `COPY services/python-audio`,`services/mastering-api` 유효 |
| 3 | server 실행 경로 | ✅ | WORKDIR `/srv/mastering-api`, `CMD uvicorn server:app --port ${PORT}` |
| 4 | python-audio import | ✅ | `ENGINE_DIR=/srv/python-audio` → `from app.analyzers.analyzer`, `from app.mastering.mastering` 해석됨 |
| 5 | ffmpeg/ffprobe | ✅ | apt `ffmpeg`(+probe) PATH 설치, 엔진 기본값 `ffmpeg`/`ffprobe` 사용. `libsndfile1`도 설치(soundfile용) |
| 6 | `MASTERING_API_KEY` | ✅ **반드시 설정** | 설정 시 인증 강제(미설정=무인증 공개). 앱 키와 동일해야 함 |
| 7 | `CORS_ALLOW_ORIGINS` | ✅ 초기 `*` 허용 | WebView origin `https://localhost` 프리플라이트 통과. 운영 안정화 후 화이트리스트로 좁힘 |
| 8 | `healthCheckPath` | ✅ | `/healthz` → `{"ok":true,...}` |
| 9 | `plan` | ✅ `starter`(확정) | 유료. 무료 대비 콜드스타트 없음 + RAM/CPU 여유(아래 §5) |
| ℹ | ffmpeg 버전 | apt 5.x 유지(확정) | 데스크톱 7.x와 미세차 가능 → 차이 확인 시에만 별도 이슈 |
| ℹ | `autoDeploy` | `false` | push 자동배포 OFF. 대시보드에서 수동 Deploy 또는 true로 변경 |

배포 절차: Render → New → **Blueprint** → 이 repo 연결 → `MASTERING_API_KEY` 입력 →
Deploy → **먼저 `/healthz` 확인** → curl 테스트(§3).

---

## 2. Render Env 설정표
| Key | 종류 | 권장값 | 설명 |
|---|---|---|---|
| `MASTERING_API_KEY` | Secret(sync:false) | 강한 랜덤 32자+ | **반드시 설정**. 앱의 `VITE_MASTERING_API_KEY`와 동일 |
| `CORS_ALLOW_ORIGINS` | Plain | 초기 미설정(=`*`) | 안정화 후 `https://localhost,capacitor://localhost,http://localhost` 로 축소 |
| `MAX_UPLOAD_MB` | Plain | **`60`** (유지) | 업로드 상한(413 초과 거부). starter RAM 여유로 60 유지 |
| `JOB_TTL_SECONDS` | Plain | `3600` | 결과 보관(초). render.yaml 기본값 |
| `ENGINE_DIR` | (Dockerfile 고정) | `/srv/python-audio` | 변경 불필요 |
| `PORT` | (Render 자동 주입) | — | 코드가 `${PORT}` 사용. 수동설정 불필요 |
| `WORK_DIR` | Plain(선택) | 미설정(시스템 temp) | 작업 스크래치 루트 |

> render.yaml은 이미 `MASTERING_API_KEY`(secret), `JOB_TTL_SECONDS=3600`,
> `MAX_UPLOAD_MB=60`, `plan: starter` 로 설정되어 있어 **그대로 배포 가능**.
> `CORS_ALLOW_ORIGINS`는 미설정이라 서버 기본값 `*` 적용(초기 테스트 OK).

---

## 3. 배포 후 curl 테스트
```bash
API=https://<your-app>.onrender.com
KEY=<MASTERING_API_KEY>

# 8) 먼저 healthz
curl -s "$API/healthz"
# → {"ok":true,"engine_dir":"/srv/python-audio","jobs":0}

# 7) CORS 프리플라이트(WebView 시뮬레이션) — ACAO 헤더 확인
curl -s -D - -o /dev/null -X OPTIONS "$API/v1/analyze" \
  -H "Origin: https://localhost" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: x-api-key" | grep -i access-control

# 9) analyze
curl -s -H "X-API-Key: $KEY" -F audio=@test.wav "$API/v1/analyze" | head -c 400

# 10) master → job_id → 폴링 → 다운로드
JOB=$(curl -s -H "X-API-Key: $KEY" \
  -F audio=@test.wav \
  -F 'options={"style":"balanced","targetLufs":-14,"targetTp":-1.0,"applyAiCorrections":true}' \
  "$API/v1/master" | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')
echo "job=$JOB"

curl -s -H "X-API-Key: $KEY" "$API/v1/jobs/$JOB"          # queued→processing(%/stage)→done
curl -s -H "X-API-Key: $KEY" -o master.wav  "$API/v1/jobs/$JOB/download?file=master"
curl -s -H "X-API-Key: $KEY" -o preview.mp3 "$API/v1/jobs/$JOB/download?file=preview"

# 인증 실패(401) / 없는 job(404)
curl -s -o /dev/null -w "%{http_code}\n" -F audio=@test.wav "$API/v1/analyze"        # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: $KEY" "$API/v1/jobs/nope"    # 404
```
> 이 흐름(analyze→master→progress→master/preview 다운로드, 401/404)은 로컬 동일
> 서버/엔진 기준 **10/10 E2E PASS** 검증됨. Render에서는 위 curl로 동일 확인.

---

## 3.5 메모리 / OOM (Starter 512MB) — 플랜 권장
**증상**: 3~4분 트랙에서 master.wav 생성 후 post-verification/ISP 단계 직후 인스턴스
restart(OOM). 서버는 in-memory job + 로컬 임시디스크라 restart 시 결과 유실.

**원인(코드 증거)**: ISP-safety가 출력 전체를 RAM에 적재(예전 float64 → 3.5분 ≈ 148MB,
보정 시 ×2 ≈ 296MB) → 파이프라인 메모리 피크.

**적용한 완화(엔진/서버, 음질 무영향)**:
- ISP 적재를 **float32**로(≤24-bit 무손실, dBTP 오차 0.000 dB) + **in-place 게인** +
  `del`/`gc` → 3분 트랙 피크 **134→71 MB(−47%)**, 보정 시 추가 절감.
- **fast mode는 ISP-safety 자체를 스킵**(`skip_isp_safety`) → ISP 적재 0. 트루피크는
  stage-6 alimiter(ceiling−0.3 dB 마진)가 유지. (모바일 앱 기본 fast)
- 완료 전후 `[job] ... status=done stored` 로그 강화. 클라이언트는 restart로 job이
  사라지면(404) **"서버 작업이 중단되어 자동 접수되었습니다"** 표시(무한폴링 방지).

**플랜 권장**:
| 플랜 | RAM | 3분+ 트랙 |
|---|---|---|
| Starter | 512MB | quality 모드 OOM 위험. **fast 모드 권장** |
| **Standard** | **2GB** | **3분+ 트랙 안전. quality 모드도 여유** |
> 3분 이상 트랙을 quality 모드로 자주 쓰면 **Standard(2GB) 승격 권장**. fast 모드만
> 쓰면 Starter에서도 ISP 스킵으로 OOM 위험이 크게 낮아짐.

---

## 4. Android 앱에 API URL / API KEY 넣는 법
두 가지 방법 — **첫 실기 테스트는 (A) 런타임 입력**이 가장 빠름(재빌드 불필요).

### (A) 런타임 입력 — 앱 "서버 설정" 화면 (권장, 재빌드 0)
1. 앱 실행 → 첫 화면 **"서버 설정"**.
2. **API URL**: `https://<your-app>.onrender.com` (반드시 https).
3. **API Key**: Render의 `MASTERING_API_KEY` 와 동일 값.
4. "계속" → 파일 선택으로 진행.
- 장점: APK 재빌드 없이 즉시 테스트.
- 참고: 현재 빌드는 입력값을 **영속 저장하지 않음**(앱 재시작 시 재입력 필요 —
  설정 영속화는 M2 이후 범위). 체크리스트 #12(재실행 테스트) 시 다시 입력.

### (B) 빌드 주입 — env로 APK에 내장 (재입력 0)
- 로컬: `apps/mobile/.env`
  ```
  VITE_MASTERING_API_URL=https://<your-app>.onrender.com
  VITE_MASTERING_API_KEY=<MASTERING_API_KEY와 동일>
  ```
  → `pnpm --filter @aimaster/mobile build && (cd apps/mobile && npx cap sync android && cd android && ./gradlew assembleDebug)`.
- CI(GitHub Actions): repo에 **Variable `VITE_MASTERING_API_URL`** + **Secret
  `VITE_MASTERING_API_KEY`** 등록 → 워크플로가 빌드시 주입 → artifact APK에 내장.
- 장점: 앱 첫 화면에 값이 채워져 있고 재시작에도 유지. 배포/시연용.

> URL은 https 필수(Android cleartext 차단). 키 불일치 시 401 → 앱에 명확한 에러 표시.

---

## 5. 무료(free) vs starter — starter 권장 사유 + 운영 권장값
**starter 채택 이유**(= free의 리스크 회피):
| free 리스크 | starter에서 | 
|---|---|
| 15분 idle 후 **spin-down → 첫 요청 30–60초** | starter는 **상시 가동**(콜드스타트 없음) |
| **RAM 512MB** → 긴/대용량 파일 디코딩(soundfile/numpy) OOM | starter RAM 여유 → 풀곡/60MB 처리 안정 |
| **CPU 0.1** → 멀티패스 ffmpeg+numpy 매우 느림 | starter CPU 여유 → 처리 시간 단축 |
| 동시성 매우 낮음 | starter에서 테스트 다중 요청 여유 |
- 공통: 디스크는 **에페메랄**이지만 결과는 TTL(`3600s`) 후 정리 + 앱이 즉시 다운로드하므로 영구 디스크 불필요.

### 실기 테스트 파일 권장값 (starter 기준)
- **길이**: 첫 실기 테스트는 **30초 ~ 2분** wav/mp3.
- **크기**: `MAX_UPLOAD_MB=60` 이내(보통 2분 wav ≈ 20–40MB).
- **샘플레이트**: 44.1kHz 권장.
- 통과 후 풀곡(3–4분)으로 확장. starter라 콜드스타트/메모리 여유 있음.

---

## 6. 배포 직후 순서 요약
1. Blueprint 배포 + `MASTERING_API_KEY` 설정(필수).
2. **`/healthz` 200 먼저 확인**.
3. §3 curl로 CORS/analyze/master/다운로드/401·404 확인.
4. 앱 "서버 설정"에 URL(https)+KEY 입력(§4-A).
5. 30초~2분 파일로 선택→마스터링→재생/공유 1회 완주.
