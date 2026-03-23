# Architecture

## Monorepo Layout

```
aimaster-desktop/
├── apps/
│   └── desktop/           # Electron + React + TypeScript
│       ├── src/
│       │   ├── main/      # Node.js main process
│       │   ├── preload/   # contextBridge (secure IPC bridge)
│       │   └── renderer/  # React SPA
│       └── electron-builder.yml
├── packages/
│   ├── audio-engine/      # Node orchestration layer
│   ├── license-core/      # HMAC license validation
│   └── shared-types/      # TypeScript types shared across packages
├── services/
│   └── python-audio/      # FFmpeg-based audio processing (JSON-RPC)
├── scripts/               # setup-python.sh etc.
└── docs/
```

## Data Flow

```
Renderer (React)
  │  window.electronAPI.invoke('audio:analyze', filePath)
  ▼
Preload (contextBridge whitelist)
  ▼
Main Process (IpcMain handler)
  │  audio-engine.analyzeFile(bridge, filePath)
  ▼
PythonBridge (stdin/stdout JSON-RPC)
  │  {"id":"uuid","method":"analyze","params":{"file_path":"..."}}
  ▼
python-audio/app/main.py
  │  analyzers/analyzer.py → ffprobe + soundfile + FFT
  ▼
Response: {"id":"uuid","result":{...AudioAnalysisResult}}
```

## IPC Channel Whitelist

| Channel                  | Direction          |
|--------------------------|--------------------|
| `audio:analyze`          | renderer → main    |
| `audio:master`           | renderer → main    |
| `audio:qc`               | renderer → main    |
| `audio:progress`         | main → renderer    |
| `license:status`         | renderer → main    |
| `license:activate`       | renderer → main    |
| `license:deactivate`     | renderer → main    |
| `file:open-dialog`       | renderer → main    |
| `file:save-dialog`       | renderer → main    |
| `file:get-info`          | renderer → main    |
| `file:open-in-finder`    | renderer → main    |
| `settings:get`           | renderer → main    |
| `settings:set`           | renderer → main    |
| `settings:choose-output-dir` | renderer → main|
| `system:ffmpeg-status`   | renderer → main    |

## Python JSON-RPC Protocol

**Request:**
```json
{ "id": "uuid-v4", "method": "analyze|master|qc_check", "params": {} }
```

**Response:**
```json
{ "id": "uuid-v4", "result": {} }
{ "id": "uuid-v4", "error": { "code": -32000, "message": "..." } }
```

**Progress event (stdout, not a response):**
```json
{ "type": "progress", "jobId": "uuid-v4", "percent": 50, "stage": "라우드니스 정규화" }
```

## License Flow

1. User enters `AIMASTER-XXXX-XXXX-XXXX`
2. `license-core` validates format regex
3. (Production) POST to remote server for key verification
4. On success: store `{ key, tier, activatedAt, machineId, hmac }` in encrypted `electron-store`
5. HMAC = `HMAC-SHA256(secret, key|tier|activatedAt|machineId)`
6. On each app start: re-verify HMAC; if tampered → downgrade to free
7. 7-day offline grace period for subscription expiry
