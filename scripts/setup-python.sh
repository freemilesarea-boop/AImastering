#!/bin/bash
# Python 가상 환경 설정 스크립트

set -e

VENV_DIR=".venv"
PYTHON="python3"

echo "=== AImastering Python 환경 설정 ==="

# Python 3.9+ 확인
PYTHON_VERSION=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
REQUIRED="3.9"
if [ "$(printf '%s\n' "$REQUIRED" "$PYTHON_VERSION" | sort -V | head -n1)" != "$REQUIRED" ]; then
    echo "ERROR: Python $REQUIRED+ 필요 (현재: $PYTHON_VERSION)"
    exit 1
fi
echo "Python $PYTHON_VERSION 확인됨"

# ffmpeg 확인
if ! command -v ffmpeg &> /dev/null; then
    echo "WARNING: ffmpeg가 설치되지 않았습니다."
    echo "  macOS: brew install ffmpeg"
    echo "  Ubuntu: sudo apt install ffmpeg"
    echo "  Windows: https://ffmpeg.org/download.html"
fi

# 가상 환경 생성
if [ ! -d "$VENV_DIR" ]; then
    echo "가상 환경 생성: $VENV_DIR"
    $PYTHON -m venv $VENV_DIR
fi

# 활성화
source $VENV_DIR/bin/activate

# 패키지 설치
echo "패키지 설치 중..."
pip install --upgrade pip -q
pip install -r requirements.txt -q

echo ""
echo "=== 설정 완료! ==="
echo "개발 시작: source .venv/bin/activate"
echo "앱 실행: npm run dev"
