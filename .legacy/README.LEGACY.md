# .legacy/ — pre-monorepo source tree

이 폴더의 모든 파일은 v3.0 이전의 root-level 구조 잔존물이며, 활성 빌드에서
import 되지 않습니다 (`.github/workflows/`, `aimaster-desktop/scripts/`,
`aimaster-desktop/apps/desktop/scripts/`, `electron-builder.yml`,
어떤 활성 `package.json` 에서도 reference 0건 — 2026-05 audit 으로 확인).

| 옛 경로 | 의도 | 활성 경로 |
|--|--|--|
| `src/main/` | Electron main + IPC | `aimaster-desktop/apps/desktop/src/main/` |
| `src/preload/` | preload bridge | `aimaster-desktop/apps/desktop/src/preload/` |
| `src/renderer/` | React UI | `aimaster-desktop/apps/desktop/src/renderer/` |
| `python/pipeline/` | DSP pipeline | `aimaster-desktop/services/python-audio/app/mastering/` |
| `python/analysis/` | metrics / QC | `aimaster-desktop/services/python-audio/app/{qc,analysis,analyzers}/` |
| `python/utils/` | ffmpeg wrapper / audio_io | `aimaster-desktop/services/python-audio/app/utils/` |
| `tests/qa/` | legacy QA harness | `aimaster-desktop/services/python-audio/tests/` |
| `vite.config.ts` etc | renderer build config | `aimaster-desktop/apps/desktop/{vite,tsconfig*,tailwind,postcss}.config.*` |
| `docs/{ARCHITECTURE,SPEC}.md` | legacy architecture docs | `aimaster-desktop/docs/` (active) |
| `README.md` | legacy install instructions | `aimaster-desktop/README.md` (active) |

이 트리는 git history 에서 reference 가능하지만 active 코드에서는 사용되지
않습니다.  새 작업은 모두 `aimaster-desktop/` 안에서 진행하세요.

— Stabilization pass, 2026-05.
