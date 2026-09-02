#!/usr/bin/env bash
# 이 스크립트는 aimaster-desktop/setup-python.sh 로 넘긴다.
#
# 예전 판은 `cd "$(git rev-parse --show-toplevel)"` 로 저장소 루트에 올라간 뒤
# services/python-audio 를 상대경로로 찾았다.  이 저장소의 git 루트는
# aimaster-desktop 의 한 단계 위라서, 루트에 빈 services/python-audio/.venv 를
# 하나 만들어 놓고 requirements.txt 를 못 찾아 죽었다.  게다가 파이썬 하한만
# 보고 상한을 안 봐서 3.13+ 에서는 numpy 핀이 소스 빌드로 떨어졌다.
# 진짜 스크립트는 두 가지를 다 제대로 한다. 사본을 고치는 대신 넘긴다.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")/.." && pwd)/setup-python.sh" "$@"
