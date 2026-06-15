# AImastering Mastering API (M0)

HTTP wrapper around the **existing** `services/python-audio` engine for the
mobile test app. The engine is reused **unchanged** (`analyze_file`,
`master_file`); this service only adds HTTP + jobs + API-key auth.

> Scope: mobile test backend only. No payment / license / account logic.
> Does not modify the desktop app or the engine.

## Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | liveness |
| POST | `/v1/analyze` | multipart `audio` → Stage-1 analysis JSON |
| POST | `/v1/master` | multipart `audio` + `options` (JSON string) → `{ job_id }` |
| GET | `/v1/jobs/{id}` | `{ status, percent, stage[, error] }` |
| GET | `/v1/jobs/{id}/download?file=master\|preview` | WAV / MP3 |

Auth: send header `X-API-Key: $MASTERING_API_KEY` (enforced only when the env
var is set; unset = open, for local dev).

`options` mirrors the desktop `audio:master` params (camelCase or snake_case):
`style, targetLufs, targetTp, lra, sampleRate, bitDepth, applyAiCorrections,
aiDetections`.

## Env
| Var | Default | Use |
|---|---|---|
| `MASTERING_API_KEY` | (unset) | API key; unset = no auth |
| `ENGINE_DIR` | `../python-audio` | engine package dir |
| `WORK_DIR` | system temp | job scratch root |
| `JOB_TTL_SECONDS` | 3600 | result retention |
| `MAX_UPLOAD_MB` | 60 | upload limit |
| `PORT` | 8080 | (Render injects) |

## Local run
```bash
cd aimaster-desktop/services/mastering-api
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r ../python-audio/requirements.txt
# ffmpeg + ffprobe must be on PATH (brew install ffmpeg / apt-get install ffmpeg)
ENGINE_DIR="$(cd ../python-audio && pwd)" uvicorn server:app --port 8080
```

## curl smoke test
```bash
API=http://localhost:8080
# analyze
curl -s -F audio=@test.wav $API/v1/analyze | head -c 400
# master → job
JOB=$(curl -s -F audio=@test.wav -F 'options={"style":"kpop_loud","targetLufs":-9,"targetTp":-0.8,"limiterStrength":"high"}' $API/v1/master | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')
# poll
curl -s $API/v1/jobs/$JOB
# download when status=done
curl -s -o master.wav  "$API/v1/jobs/$JOB/download?file=master"
curl -s -o preview.mp3 "$API/v1/jobs/$JOB/download?file=preview"
```
(add `-H "X-API-Key: $MASTERING_API_KEY"` to every call when the key is set.)

## Docker (build context = aimaster-desktop)
```bash
cd aimaster-desktop
docker build -f services/mastering-api/Dockerfile -t aimaster-api .
docker run -p 8080:8080 -e MASTERING_API_KEY=dev aimaster-api
```

## Render
Use the repo-root `render.yaml` (Blueprint) or configure manually:
runtime Docker, rootDir `aimaster-desktop`, dockerfilePath
`./services/mastering-api/Dockerfile`, dockerContext `.`, healthCheck
`/healthz`, secret `MASTERING_API_KEY`.
