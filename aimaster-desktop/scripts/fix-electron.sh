#!/usr/bin/env bash
# Electron 바이너리 복구.
#
# 세 가지가 겹쳐서 이 스크립트가 필요하다.
#   1. pnpm 이 electron 의 postinstall 을 건너뛰는 경우가 있다 (스토어 재사용).
#   2. 압축 해제가 중간에 끊기면 실행 파일은 있는데 프레임워크가 없는 dist 가
#      남는다.  파일 하나만 보고 "설치됨" 이라 하면 이걸 놓친다.  실행하면
#      dyld: Library not loaded: @rpath/Electron Framework.framework 로 죽는다.
#   3. ELECTRON_SKIP_BINARY_DOWNLOAD 가 환경에 남아 있으면 install.js 는 아무
#      것도 하지 않고 0 으로 끝난다.  고치려고 부를수록 조용히 실패한다.
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
  Darwin)               OS="darwin"; EXE_REL="Electron.app/Contents/MacOS/Electron"
                        WITNESS="Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" ;;
  Linux)                OS="linux";  EXE_REL="electron";     WITNESS="libffmpeg.so" ;;
  MINGW*|MSYS*|CYGWIN*) OS="win32";  EXE_REL="electron.exe"; WITNESS="resources.pak" ;;
  *) echo "✗ 지원하지 않는 플랫폼: $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) echo "✗ 지원하지 않는 아키텍처: $(uname -m)"; exit 1 ;;
esac

# 이게 켜져 있으면 install.js 는 즉시 0 으로 끝난다. 이 스크립트 안에서는 끈다.
SKIP_WAS_SET=""
if [ -n "${ELECTRON_SKIP_BINARY_DOWNLOAD:-}" ]; then
  SKIP_WAS_SET="$ELECTRON_SKIP_BINARY_DOWNLOAD"
  echo "→ ELECTRON_SKIP_BINARY_DOWNLOAD='$SKIP_WAS_SET' 가 설정되어 있습니다 — install.js 가 아무것도 안 하는 원인입니다. 이 스크립트 안에서는 무시합니다."
fi
unset ELECTRON_SKIP_BINARY_DOWNLOAD ELECTRON_OVERRIDE_DIST_PATH || true

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

wipe() { rm -rf "$DIR/dist" "$DIR/path.txt"; }   # 지워야 install.js 가 건너뛰지 않는다

# ── 방법 1·2: electron 자신의 install.js ──────────────────────────────────────
by_install_js() {
  wipe
  ( cd "$DIR" && env "$@" node install.js ) || return 1
  [ -e "$DIR/dist" ] || { echo "  install.js 가 아무것도 만들지 않았습니다"; return 1; }
}

# ── 방법 3: 릴리스 zip 을 직접 받아서 체크섬 확인 후 푼다 ─────────────────────
# install.js 가 조용히 실패하는 경우가 있어서, 그 경로를 통째로 우회하는 수단이
# 하나 있어야 한다.  체크섬은 electron 패키지가 들고 있는 checksums.json 것을
# 쓴다 — 캐시에 깨진 zip 이 남는 게 애초에 이 사태의 원인 중 하나였다.
by_direct_download() {
  local name url zip want_sum got_sum
  name="electron-v${WANT}-${OS}-${ARCH}.zip"
  want_sum="$(node -p "require('./$DIR/checksums.json')['$name'] || ''")"
  [ -n "$want_sum" ] || { echo "  checksums.json 에 $name 이 없습니다"; return 1; }
  url="https://github.com/electron/electron/releases/download/v${WANT}/${name}"
  zip="$(mktemp -t electron-zip.XXXXXX)"
  echo "  $url"
  curl -fL --progress-bar -o "$zip" "$url" || { rm -f "$zip"; return 1; }
  got_sum="$(node -e "const c=require('crypto'),f=require('fs');const h=c.createHash('sha256');h.update(f.readFileSync('$zip'));console.log(h.digest('hex'))")"
  if [ "$got_sum" != "$want_sum" ]; then
    echo "  체크섬 불일치 — 받은 파일이 손상됐습니다"
    echo "    기대: $want_sum"
    echo "    실제: $got_sum"
    rm -f "$zip"; return 1
  fi
  echo "  체크섬 확인 (sha256 ${want_sum:0:12}…)"
  wipe
  mkdir -p "$DIR/dist"
  # 맥에서는 ditto 를 쓴다 — unzip 은 .framework 안의 심볼릭 링크를 제대로
  # 복원하지 못하는 경우가 있고, 그게 정확히 지금 깨진 부분이다.
  if [ "$OS" = "darwin" ]; then ditto -x -k "$zip" "$DIR/dist"
  else unzip -q -o "$zip" -d "$DIR/dist"; fi
  rm -f "$zip"
  printf '%s' "$EXE_REL" > "$DIR/path.txt"
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
  by_install_js || true
  WHY="$(diagnose)"
fi
if [ -n "$WHY" ]; then
  # 캐시에 깨진 zip 이 남아 있으면 다시 받아도 같은 결과가 나온다. 캐시를 건너뛴다.
  echo "→ 여전히: $WHY"
  echo "→ 다운로드 캐시를 건너뛰고 한 번 더 받습니다..."
  by_install_js force_no_cache=true || true
  WHY="$(diagnose)"
fi
if [ -n "$WHY" ]; then
  echo "→ 여전히: $WHY"
  echo "→ install.js 를 건너뛰고 릴리스 zip 을 직접 받습니다..."
  by_direct_download || true
  WHY="$(diagnose)"
fi
if [ -n "$WHY" ]; then
  echo "✗ Electron 설치를 복구하지 못했습니다: $WHY"
  [ -n "$SKIP_WAS_SET" ] && echo "  ELECTRON_SKIP_BINARY_DOWNLOAD 를 셸 설정(~/.zshrc 등)에서 지우고 새 터미널에서 다시 시도하세요."
  exit 1
fi

# 검증은 require('electron') 으로 한다.  바이너리를 실제 경로로 직접 부르면
# path.txt 를 읽지 않으므로, 깨진 path.txt 를 두고도 멀쩡해 보인다.
EXE="$(node -p "require('$PWD/$DIR')" 2>/dev/null || true)"
[ -x "$EXE" ] || { echo "✗ require('electron') 이 실행 가능한 경로를 주지 못했습니다: '$EXE'"; exit 1; }
echo "✓ Electron v$WANT ($OS-$ARCH) — $EXE"
if [ -n "$SKIP_WAS_SET" ]; then
  echo "  참고: ELECTRON_SKIP_BINARY_DOWNLOAD 가 환경에 설정되어 있습니다."
  echo "  셸 설정(~/.zshrc 등)에서 지우지 않으면 다음 pnpm install 에서 또 같은 일이 납니다."
fi
