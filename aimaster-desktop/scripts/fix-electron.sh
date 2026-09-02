#!/usr/bin/env bash
# Electron 바이너리 복구.
#
# pnpm 이 electron 의 postinstall 을 건너뛰거나(스토어 재사용, 사이드이펙트 캐시)
# 압축 해제가 중간에 끊기면 node_modules/electron/dist 가 반쯤 만들어진 채로
# 남는다.  실행 파일은 있는데 프레임워크가 없는 식이라, 파일 하나만 보고
# "설치됨" 이라고 판단하면 안 된다.  electron 자신의 isInstalled() 는 dist/version
# 이 package.json 의 버전과 같은지까지 보는데, 이 스크립트도 그 기준을 쓰고
# 플랫폼마다 반드시 있어야 하는 파일을 하나 더 본다.
#
# path.txt 도 같이 본다 — electron 의 index.js 는 이 파일을 trim 없이 읽어서
# 실행 경로에 이어 붙이므로, 끝에 줄바꿈이 하나만 붙어도 없는 파일을 spawn 한다.
#   echo "..."   > path.txt   ← 줄바꿈이 붙는다. 이러면 안 된다.
#   printf '%s'  > path.txt   ← 이렇게.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

DIR="node_modules/electron"
[ -d "$DIR" ] || { echo "✗ $DIR 이 없습니다 — 먼저 pnpm install"; exit 1; }

WANT="$(node -p "require('./$DIR/package.json').version")"

# electron/install.js 의 getPlatformPath() 와 같은 값이어야 한다.
case "$(uname -s)" in
  Darwin)            EXE_REL="Electron.app/Contents/MacOS/Electron"
                     WITNESS="Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" ;;
  Linux|*BSD)        EXE_REL="electron"
                     WITNESS="libffmpeg.so" ;;
  MINGW*|MSYS*|CYGWIN*) EXE_REL="electron.exe"
                     WITNESS="resources.pak" ;;
  *) echo "✗ 지원하지 않는 플랫폼: $(uname -s)"; exit 1 ;;
esac

# 왜 건강하지 않은지 한 줄로 돌려준다. 비어 있으면 건강한 것.
diagnose() {
  if [ ! -f "$DIR/path.txt" ]; then echo "path.txt 없음"; return; fi
  # 끝의 줄바꿈을 보존한 채로 읽는다. $(cat) 은 그걸 지워버려서 검사가 무의미해진다.
  local raw trimmed have
  raw="$(cat "$DIR/path.txt"; printf x)"; raw="${raw%x}"
  trimmed="$(printf '%s' "$raw" | tr -d '\r\n')"
  if [ "$raw" != "$trimmed" ]; then echo "path.txt 끝에 줄바꿈"; return; fi
  if [ "$trimmed" != "$EXE_REL" ]; then echo "path.txt 가 '$trimmed' 를 가리킴 (이 플랫폼은 '$EXE_REL')"; return; fi
  if [ ! -f "$DIR/dist/version" ]; then echo "dist/version 없음 — 압축 해제가 끝나지 않았습니다"; return; fi
  have="$(tr -d ' \t\r\n' < "$DIR/dist/version")"; have="${have#v}"
  if [ "$have" != "$WANT" ]; then echo "dist 는 v$have 인데 package.json 은 v$WANT"; return; fi
  if [ ! -x "$DIR/dist/$EXE_REL" ]; then echo "실행 파일 없음: dist/$EXE_REL"; return; fi
  if [ ! -f "$DIR/dist/$WITNESS" ]; then echo "dist/$WITNESS 없음 — 설치가 불완전합니다"; return; fi
}

install_fresh() {
  rm -rf "$DIR/dist" "$DIR/path.txt"   # 지워야 install.js 가 건너뛰지 않는다
  ( cd "$DIR" && env "$@" node install.js )
}

WHY="$(diagnose)"

# 줄바꿈 하나 때문에 100 MB 를 다시 받을 이유는 없다. 그것만 문제라면 그 자리에서 고친다.
if [ "$WHY" = "path.txt 끝에 줄바꿈" ]; then
  printf '%s' "$(tr -d '\r\n' < "$DIR/path.txt")" > "$DIR/path.txt"
  echo "→ path.txt 끝의 줄바꿈을 제거했습니다"
  WHY="$(diagnose)"
fi

if [ -n "$WHY" ]; then
  echo "→ $WHY"
  echo "→ Electron 바이너리를 다시 받습니다..."
  install_fresh
  WHY="$(diagnose)"
fi
if [ -n "$WHY" ]; then
  # 캐시에 깨진 zip 이 남아 있으면 다시 받아도 같은 결과가 나온다. 캐시를 건너뛴다.
  echo "→ 여전히: $WHY"
  echo "→ 다운로드 캐시를 건너뛰고 한 번 더 받습니다..."
  install_fresh force_no_cache=true
  WHY="$(diagnose)"
fi
if [ -n "$WHY" ]; then
  echo "✗ Electron 설치를 복구하지 못했습니다: $WHY"
  exit 1
fi

# 검증은 require('electron') 으로 한다.  바이너리를 실제 경로로 직접 부르면
# path.txt 를 읽지 않으므로, 깨진 path.txt 를 두고도 멀쩡해 보인다.
EXE="$(node -p "require('$PWD/$DIR')" 2>/dev/null || true)"
[ -x "$EXE" ] || { echo "✗ require('electron') 이 실행 가능한 경로를 주지 못했습니다: '$EXE'"; exit 1; }
echo "✓ Electron v$WANT — $EXE"
