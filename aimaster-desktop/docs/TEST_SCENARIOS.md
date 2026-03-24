# AIMASTER E2E 테스트 시나리오

개발자가 바로 실행할 수 있는 5개의 테스트 시나리오. 각 시나리오는 **전제 조건**, **실행 단계**, **기대 결과**, **실패 시 디버깅 포인트**로 구성됩니다.

---

## 사전 준비: 테스트 오디오 파일 생성

테스트 전용 오디오 파일을 ffmpeg으로 즉시 생성합니다:

```bash
mkdir -p /tmp/aimaster-test

# A. 표준 테스트 파일 — 10초 440Hz 사인파 (Stereo, 44.1kHz, 24bit)
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" \
  -ar 44100 -acodec pcm_s24le -ac 2 \
  /tmp/aimaster-test/sine_440hz_10s.wav

# B. 저라우드니스 파일 — 볼륨을 크게 낮춤 (≈ -30 LUFS)
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" \
  -ar 44100 -acodec pcm_s24le -ac 2 \
  -af "volume=-15dB" \
  /tmp/aimaster-test/quiet_-30lufs.wav

# C. 실제 음악 대체 파일 — 핑크 노이즈 30초 (다이내믹 레인지 풍부)
ffmpeg -f lavfi -i "anoisesrc=color=pink:duration=30" \
  -ar 44100 -acodec pcm_s24le -ac 2 \
  /tmp/aimaster-test/pink_noise_30s.wav

# D. 짧은 클립 — 3초 (최소 처리 가능 길이)
ffmpeg -f lavfi -i "sine=frequency=1000:duration=3" \
  -ar 44100 -acodec pcm_s16le \
  /tmp/aimaster-test/short_3s.wav

# E. 한글 경로 파일 — 경로 인코딩 테스트
mkdir -p "/tmp/aimaster-test/한글 폴더"
cp /tmp/aimaster-test/sine_440hz_10s.wav "/tmp/aimaster-test/한글 폴더/테스트 파일.wav"

# 생성 확인
ls -lh /tmp/aimaster-test/
```

---

## 시나리오 1: 표준 마스터링 성공 경로

**목적:** 핵심 마스터링 파이프라인이 처음부터 끝까지 정상 동작하는지 검증.

**전제 조건**
- `AIMASTER_PYTHON` 설정됨
- FFmpeg + FFprobe PATH에 있음
- `/tmp/aimaster-test/sine_440hz_10s.wav` 존재

**실행 단계**
1. `pnpm desktop` 실행
2. `sine_440hz_10s.wav` 드롭
3. AnalysisPage에서 값 확인:
   - 샘플레이트: 44100 Hz
   - 비트뎁스: 24-bit
   - 채널: Stereo
   - 라우드니스 값이 숫자로 표시됨
4. 스타일: `Balanced` 선택
5. "마스터링 시작" 클릭
6. MasteringPage에서 5단계 완료 대기
7. ResultPage 확인

**기대 결과**
```
Before (AnalysisPage):
  Integrated LUFS: ≈ -15 ~ -14 LUFS (사인파는 거의 고정)
  True Peak:       ≈ 0 dBTP (클리핑 수준)
  LRA:             ≈ 0 LU (단일 주파수)

After (ResultPage):
  Integrated LUFS: -14.0 ± 1.5 LUFS
  True Peak:       ≤ -1.0 dBTP
  processingTimeSec: < 30초

ResultPage 추가 확인:
  - MP3 프리뷰 플레이어에 오디오 로드됨
  - "프리뷰 MP3 저장" 버튼 클릭 시 대화상자 표시
```

**CLI 검증 (앱 없이)**
```bash
# Python 엔진 직접 실행
source services/python-audio/.venv/bin/activate
cd services/python-audio

python3 - <<'PYEOF'
import json, subprocess, uuid, os, sys

env = {**os.environ, 'PYTHONUNBUFFERED': '1'}
proc = subprocess.Popen(
    [sys.executable, '-m', 'app.main'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, env=env
)

# Wait READY
for line in proc.stderr:
    sys.stderr.write(f"[py] {line}")
    if 'READY' in line:
        break

req = json.dumps({
    "id": str(uuid.uuid4()),
    "method": "master",
    "params": {
        "input_path":  "/tmp/aimaster-test/sine_440hz_10s.wav",
        "output_path": "/tmp/aimaster-test/output_balanced.wav",
        "style": "balanced",
        "target_lufs": -14.0,
        "target_tp": -1.0,
        "sample_rate": 44100,
        "bit_depth": 24,
        "apply_ai_corrections": True
    }
})
proc.stdin.write(req + '\n')
proc.stdin.flush()

resp = json.loads(proc.stdout.readline())
if 'error' in resp:
    print(f"ERROR: {resp['error']}", file=sys.stderr)
else:
    r = resp['result']
    print(f"LUFS after: {r['loudnessAfter']['integratedLufs']}")
    print(f"TP after:   {r['loudnessAfter']['truePeakDbtp']}")
    print(f"Time:       {r['processingTimeSec']}s")
    print(f"Output:     {r['outputPath']}")
proc.terminate()
PYEOF
```

---

## 시나리오 2: 저라우드니스 파일 마스터링

**목적:** 입력이 매우 조용한(-30 LUFS) 파일도 목표 LUFS로 끌어올리는지 검증.

**전제 조건**
- `/tmp/aimaster-test/quiet_-30lufs.wav` 존재

**실행 단계**
1. `quiet_-30lufs.wav` 드롭
2. AnalysisPage에서 LUFS ≈ -30 LUFS 확인 (QC 뱃지: "확인 필요")
3. 스타일: `Warm` 선택
4. "마스터링 시작"

**기대 결과**
```
Before:
  Integrated LUFS: ≈ -30 LUFS
  QC 뱃지: "확인 필요" (주황/빨강)

After:
  Integrated LUFS: -14.0 ± 1.5 LUFS  ← 핵심
  True Peak: ≤ -1.0 dBTP
```

**실패 조건:** `-inf LUFS` 출력 → 완전 무음 파일로 판단됨 (이 시나리오에서는 발생하면 안 됨)

**CLI 검증**
```bash
ffmpeg -hide_banner -i /tmp/aimaster-test/quiet_-30lufs.wav \
  -af "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json" \
  -f null - 2>&1 | tail -20

# 출력에서 JSON 블록 확인:
# {
#   "input_i" : "-30.xx",   ← 입력 LUFS
#   ...
# }
```

---

## 시나리오 3: 스타일 프리셋 4종 비교

**목적:** 4가지 프리셋(Balanced, Warm, Bright, Punch)이 실제로 다른 출력을 만드는지 검증.

**실행 단계 (CLI — 앱 없이)**
```bash
source services/python-audio/.venv/bin/activate
cd services/python-audio

for STYLE in balanced warm bright punch; do
  OUT="/tmp/aimaster-test/output_${STYLE}.wav"
  python3 - <<PYEOF
import json, subprocess, uuid, os, sys

env = {**os.environ, 'PYTHONUNBUFFERED': '1'}
proc = subprocess.Popen(
    [sys.executable, '-m', 'app.main'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, env=env
)
for line in proc.stderr:
    if 'READY' in line:
        break

req = json.dumps({
    "id": str(uuid.uuid4()),
    "method": "master",
    "params": {
        "input_path": "/tmp/aimaster-test/pink_noise_30s.wav",
        "output_path": "$OUT",
        "style": "$STYLE",
        "target_lufs": -14.0,
        "target_tp": -1.0,
        "sample_rate": 44100,
        "bit_depth": 24,
        "apply_ai_corrections": True
    }
})
proc.stdin.write(req + '\n')
proc.stdin.flush()
resp = json.loads(proc.stdout.readline())
r = resp.get('result', {})
ac = ', '.join(r.get('appliedCorrections', []))
print(f"[$STYLE] LUFS={r.get('loudnessAfter',{}).get('integratedLufs','?')}, corrections: {ac}")
proc.terminate()
PYEOF
done
```

**기대 결과**
```
[balanced] LUFS=-14.x, corrections: Balanced 스타일 EQ 적용, ...
[warm]     LUFS=-14.x, corrections: Warm 스타일 EQ 적용, ...
[bright]   LUFS=-14.x, corrections: Bright 스타일 EQ 적용, ...
[punch]    LUFS=-14.x, corrections: Punch 스타일 EQ 적용, ...
```

모든 스타일에서 LUFS는 -14 ± 1.5 범위여야 하며, `appliedCorrections`가 스타일별로 달라야 함.

---

## 시나리오 4: 에러 케이스 — 손상된/지원 불가 파일

**목적:** 비정상 입력 파일에 대해 구조화된 에러가 정확히 발생하는지 검증.

**테스트 A: 빈 파일 (0 bytes)**
```bash
touch /tmp/aimaster-test/empty.wav
# 앱에서 드롭 → "파일 크기가 0입니다" 에러 메시지 확인
```

**테스트 B: 텍스트 파일에 .wav 확장자**
```bash
echo "this is not audio" > /tmp/aimaster-test/fake.wav
# 앱에서 드롭 → "파일이 손상되었거나 지원하지 않는 형식" 에러 확인
```

**테스트 C: 비디오 파일에서 오디오 스트림 없음**
```bash
# 오디오 스트림이 없는 파일 생성 (실제로는 영상 파일)
ffmpeg -f lavfi -i "color=black:size=320x240:duration=5" \
  -an /tmp/aimaster-test/video_no_audio.mp4
# 앱에서 드롭 → 지원하지 않는 포맷 에러 확인
```

**CLI로 에러 구조 직접 확인**
```bash
source services/python-audio/.venv/bin/activate
cd services/python-audio
echo '{"id":"err1","method":"analyze","params":{"file_path":"/tmp/aimaster-test/empty.wav"}}' \
  | python -m app.main
# 기대 응답:
# {"id":"err1","error":{"code":-32000,"message":"파일 크기가 0입니다..."}}
```

**기대 에러 코드 매핑**

| 입력 상황 | AppErrorCode | recoverable |
|-----------|-------------|-------------|
| ffmpeg 없음 | `FFMPEG_NOT_FOUND` | false |
| ffprobe 없음 | `FFPROBE_NOT_FOUND` | false |
| 0바이트 파일 | `FILE_CORRUPTED` | false |
| 텍스트.wav | `FILE_CORRUPTED` | false |
| 완전 무음 파일 | `LOUDNORM_PARSE_FAILED` | false |
| 임시 디렉토리 쓰기 불가 | `OUTPUT_DIR_NOT_WRITABLE` | false |

---

## 시나리오 5: 무료 → Pro 라이선스 전환 + WAV 저장

**목적:** 라이선스 게이트가 올바르게 작동하는지 확인 (무료=WAV 차단, Pro=WAV 허용).

**전제 조건**
- 앱이 새로 설치된 상태 (또는 `~/Library/Application Support/AIMASTER/license.json` 삭제)
- 처리 가능한 오디오 파일

**실행 단계**

**Part A — 무료 체험 확인**
1. 앱 실행 → SettingsPage → 라이선스: "무료" 뱃지, "3 / 3 회 남음"
2. 파일 마스터링 → ResultPage
3. "마스터 WAV 저장" 버튼: 잠금 아이콘, 클릭 시 라이선스 모달 표시 확인
4. SettingsPage → "2 / 3 회 남음" 으로 감소 확인

**Part B — Pro 활성화**
1. SettingsPage → "라이선스 키 입력"
2. `AIMASTER-ABCD-EFGH-1234` 입력 (v1 로컬 검증: 형식만 체크)
3. "활성화" → "Pro" 뱃지로 변경 확인

**Part C — Pro 상태에서 WAV 저장**
1. 파일 마스터링 → ResultPage
2. "마스터 WAV 저장" 버튼 활성화 확인 (잠금 아이콘 없음)
3. 클릭 → 저장 대화상자 → 경로 선택 → 저장
4. 저장된 파일 존재 확인:
```bash
ls -lh /path/to/saved_master.wav
# 기대: 수십 MB (24-bit WAV)

ffprobe -v quiet -show_streams /path/to/saved_master.wav 2>&1 | \
  grep -E 'codec_name|sample_rate|bits_per'
# 기대:
#   codec_name=pcm_s24le
#   sample_rate=44100
#   bits_per_raw_sample=24
```

**라이선스 로그 확인**
```bash
grep '\[license\]' ~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log
# 기대:
#   [license] trial used — 2 remaining
#   [license] trial used — 1 remaining
```

**HMAC 위변조 테스트 (추가)**
```bash
# 라이선스 파일 직접 편집 시도 (실제 파일은 암호화됨 — 이 테스트는 개념 확인용)
# 암호화되어 있어 직접 편집 불가 → electron-store 암호화 정상 동작 확인
cat ~/Library/Application\ Support/AIMASTER/license.json 2>/dev/null | head -3
# 기대: 암호화된 바이너리/문자열, 평문 JSON 아님
```

---

## 실패 시 공통 디버깅 절차

```bash
# 1. 로그에서 에러 추출
LOG_FILE=~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log
grep '\[ERROR\]' "$LOG_FILE" | tail -20

# 2. Python 엔진 직접 확인
grep '\[python\]' "$LOG_FILE" | tail -20

# 3. FFmpeg 상태 확인
ffmpeg -version | head -1
ffprobe -version | head -1
which ffmpeg ffprobe

# 4. Python 환경 확인
$AIMASTER_PYTHON --version
$AIMASTER_PYTHON -c "import soundfile, numpy; print('deps OK')"

# 5. 파이프라인 단독 실행 (verbose)
source services/python-audio/.venv/bin/activate
cd services/python-audio
PYTHONUNBUFFERED=1 python -m app.main <<'EOF'
{"id":"dbg","method":"analyze","params":{"file_path":"/tmp/aimaster-test/sine_440hz_10s.wav"}}
EOF
```
