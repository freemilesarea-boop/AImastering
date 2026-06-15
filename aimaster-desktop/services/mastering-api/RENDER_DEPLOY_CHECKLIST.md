# Render 배포 최종 점검 — M0 Mastering API

모바일 앱이 호출 가능한 형태로 M0 서버를 Render에 올리기 위한 체크리스트 ·
env 표 · 배포 후 curl 테스트 · 무료 플랜 리스크/권장값. (정적 검증 완료 기준)

> 범위: 배포 설정만. 엔진 로직 · 모바일 기능 · 결제/계정 · 데스크톱은 건드리지 않음.

---

## 1. 배포 전 체크리스트 (정적 검증 결과)
| # | 항목 | 상태 | 근거 |
|---|---|---|---|
| 1 | `render.yaml` 경로/rootDir | ✅ | `rootDir: aimaster-desktop`, `dockerfilePath: ./services/mastering-api/Dockerfile` |
| 2 | Dockerfile build context | ✅ | `dockerContext: .`(= aimaster-desktop) → `COPY services/python-audio`,`services/mastering-api` 유효 |
| 3 | server 실행 경로 | ✅ | WORKDIR `/srv/mastering-api`, `CMD uvicorn server:app --port ${PORT}` |
| 4 | python-audio import | ✅ | `ENGINE_DIR=/srv/python-audio` → `from app.analyzers.analyzer`, `from app.mastering.mastering` 해석됨 |
| 5 | ffmpeg/ffprobe | ✅ | apt `ffmpeg`(+probe) PATH 설치, 엔진 기본값 `ffmpeg`/`ffprobe` 사용. `libsndfile1`도 설치(soundfile용) |
| 6 | `MASTERING_API_KEY` | ✅ 필요 | 설정 시 인증 강제(미설정=무인증 공개). **테스트라도 설정 권장** |
| 7 | `CORS_ALLOW_ORIGINS` | ✅ 기본 `*` | WebView origin `https://localhost` 프리플라이트 통과. 운영 시 화이트리스트 권장(아래) |
| 8 | `healthCheckPath` | ✅ | `/healthz` → `{"ok":true,...}` |
| ⚠ | `plan` | 확인 필요 | 현재 **`starter`(유료)**. 무료는 `plan: free`로 변경(아래 리스크 참고) |
| ⚠ | ffmpeg 버전 parity | 참고 | Debian slim = ffmpeg **5.x**, 데스크톱 번들 = 7.x. 음질/필터 미세차 가능(차단요인 아님) |
| ℹ | `autoDeploy` | `false` | push 자동배포 OFF. 대시보드에서 수동 Deploy 또는 true로 변경 |

배포 절차: Render → New → **Blueprint** → 이 repo 연결 → `MASTERING_API_KEY` 입력 →
Deploy → `/healthz` 확인.

---

## 2. Render Env 설정표
| Key | 종류 | 권장값(테스트) | 설명 |
|---|---|---|---|
| `MASTERING_API_KEY` | Secret(sync:false) | 강한 랜덤 32자+ | 앱의 `VITE_MASTERING_API_KEY`와 동일해야 함 |
| `CORS_ALLOW_ORIGINS` | Plain | `https://localhost,capacitor://localhost,http://localhost` | 미설정 시 `*`(테스트 허용). 타이트하게 하려면 이 값 |
| `MAX_UPLOAD_MB` | Plain | **`20`** (free) / `60`(starter+) | 업로드 상한. free RAM 보호 위해 낮춤 |
| `JOB_TTL_SECONDS` | Plain | `1800` | 결과 보관(초). free 디스크 절약 위해 30분 |
| `ENGINE_DIR` | (Dockerfile 고정) | `/srv/python-audio` | 변경 불필요 |
| `PORT` | (Render 자동 주입) | — | 코드가 `${PORT}` 사용. 수동설정 불필요 |
| `WORK_DIR` | Plain(선택) | 미설정(시스템 temp) | 작업 스크래치 루트 |

> 앱 빌드 측: `VITE_MASTERING_API_URL=https://<app>.onrender.com`(https 필수),
> `VITE_MASTERING_API_KEY=<위 키와 동일>`.

---

## 3. 배포 후 curl 테스트
```bash
API=https://<your-app>.onrender.com
KEY=<MASTERING_API_KEY>

# 8) healthz (무료 플랜은 콜드스타트로 첫 응답이 느릴 수 있음)
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

# 폴링 (status: queued→processing(%/stage)→done)
curl -s -H "X-API-Key: $KEY" "$API/v1/jobs/$JOB"

# done 후 다운로드
curl -s -H "X-API-Key: $KEY" -o master.wav  "$API/v1/jobs/$JOB/download?file=master"
curl -s -H "X-API-Key: $KEY" -o preview.mp3 "$API/v1/jobs/$JOB/download?file=preview"

# 인증 실패(401) / 없는 job(404)
curl -s -o /dev/null -w "%{http_code}\n" -F audio=@test.wav "$API/v1/analyze"        # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: $KEY" "$API/v1/jobs/nope"    # 404
```
> 이 흐름(analyze→master→progress→master/preview 다운로드, 401/404)은 로컬 동일
> 서버/엔진에 대해 **10/10 E2E PASS**로 검증됨. Render에서는 위 curl로 동일 확인.

---

## 4. 무료 플랜(free) 리스크와 임시 운영 권장값
| 리스크 | 영향 | 임시 대응 |
|---|---|---|
| **콜드스타트**(15분 무활동 시 spin-down) | 첫 요청 ~30–60초 지연 | 테스트 직전 `/healthz` 1회 호출로 워밍업. 앱 첫 호출 느림을 감안 |
| **RAM 512MB** | 긴/대용량 파일 디코딩(soundfile/numpy) OOM → job=error | `MAX_UPLOAD_MB=20`, **짧은 클립** 사용(아래) |
| **CPU 0.1** | 멀티패스 ffmpeg+numpy 느림 | 짧은 파일 우선. 처리 수십 초 감안(앱은 job 비동기라 타임아웃 아님) |
| **에페메랄 디스크** | 재시작 시 결과 소실 | TTL(`JOB_TTL_SECONDS=1800`)로 충분. 영구 보관 불필요(앱이 즉시 다운로드) |
| **요청/대역 제한** | 느린 모바일망 대용량 업로드 지연 | 작은 파일 + 재시도(앱 내장). https 필수 |
| **동시성 낮음** | 다중 마스터링 시 큐 적체 | 테스트는 1건씩 |

### 실사용 테스트 권장 파일 제한 (임시)
- **길이**: 1차 통과는 **30–60초 클립** 권장(최대 ~90초). 풀곡(3–4분)은 free에서 RAM/CPU 위험.
- **포맷/크기**: wav/mp3, **≤ ~15–20MB**. (`MAX_UPLOAD_MB=20`과 정합)
- **샘플레이트**: 44.1kHz 권장.
- 안정 확인 후 → **`plan: starter`(유료)** 로 올리면 풀곡/60MB 여유 + 콜드스타트 없음.

> 권장: **테스트 1차 = free + 짧은 클립**, **안정화/시연 = starter**. render.yaml은 현재
> `starter` 이므로, free로 시험하려면 `plan: free` + 위 env(`MAX_UPLOAD_MB=20` 등)로 조정.
