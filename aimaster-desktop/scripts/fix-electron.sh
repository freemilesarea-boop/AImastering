#!/usr/bin/env bash
# Electron 바이너리 복구.
#
# pnpm install 이 electron 의 postinstall 을 건너뛰는 경우가 있다(스토어 재사용,
# 사이드이펙트 캐시).  그러면 node_modules/electron/dist 가 비어 있어서 `pnpm dev`
# 가 ENOENT 로 죽는다.  path.txt 가 깨진 경우도 같이 본다 — electron 의 index.js
# 는 path.txt 를 trim 없이 읽어서 실행 경로에 이어 붙이기 때문에, 끝에 줄바꿈이
# 하나만 붙어 있어도 존재하지 않는 파일을 spawn 하게 된다.
#   echo "..."  > path.txt   ← 줄바꿈이 붙는다. 이러면 안 된다.
#   printf '%s' > path.txt   ← 이렇게.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

DIR="node_modules/electron"
[ -d "$DIR" ] || { echo "✗ $DIR 이 없습니다 — 먼저 pnpm install"; exit 1; }
PATH_FILE="$DIR/path.txt"

reinstall=0
if [ ! -f "$PATH_FILE" ]; then
  echo "→ path.txt 없음"
  reinstall=1
else
  # 끝의 줄바꿈을 보존한 채로 읽는다. $(cat) 은 그걸 지워버려서 검사가 무의미해진다.
  raw="$(cat "$PATH_FILE"; printf x)"; raw="${raw%x}"
  trimmed="$(printf '%s' "$raw" | tr -d '\r\n')"
  if [ "$raw" != "$trimmed" ]; then
    printf '%s' "$trimmed" > "$PATH_FILE"
    echo "→ path.txt 끝의 줄바꿈을 제거했습니다"
  fi
  [ -x "$DIR/dist/$trimmed" ] || { echo "→ $DIR/dist/$trimmed 없음"; reinstall=1; }
fi

if [ "$reinstall" -eq 1 ]; then
  echo "→ Electron 바이너리를 내려받습니다..."
  node "$DIR/install.js"
fi

# 검증은 반드시 require('electron') 으로 한다.  바이너리를 실제 경로로 직접
# 호출하면 path.txt 를 읽지 않으므로, 깨진 path.txt 를 두고도 --version 이
# 멀쩡하게 찍힌다.  그게 이 버그를 처음에 못 잡은 이유였다.
EXE="$(node -p "require('$PWD/$DIR')" 2>/dev/null || true)"
if [ -z "$EXE" ] || [ ! -x "$EXE" ]; then
  echo "✗ require('electron') 이 실행 가능한 경로를 주지 못했습니다: '${EXE}'"
  exit 1
fi
# 버전은 dist/version 을 먼저 본다.  바이너리를 --version 으로 부르는 건 샌드박스
# 없는 환경(도커·root)에서 죽어서 멀쩡한 설치를 실패로 보고한다.
VERSION="$(cat "$DIR/dist/version" 2>/dev/null || true)"
[ -n "$VERSION" ] || VERSION="$("$EXE" --version 2>/dev/null || echo '?')"
echo "✓ Electron v${VERSION#v} — $EXE"
