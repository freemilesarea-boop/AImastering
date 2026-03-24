# AIMASTER QA 체크리스트

수동 QA 실행 기준 문서. 각 항목마다 **확인 방법**, **기대 결과**, **실패 시 확인할 로그** 를 명시.

> **실행 전 준비**
> ```bash
> export AIMASTER_PYTHON="$(pwd)/services/python-audio/.venv/bin/python"
> pnpm desktop
> # Electron DevTools: Cmd+Option+I (macOS) / Ctrl+Shift+I (Linux/Win)
> ```

---

## 체크리스트

### [ ] 1. 파일 업로드 성공 여부

**테스트 방법**
1. 앱 실행 → HomePage
2. WAV 파일을 드롭존에 드래그 앤 드롭
3. 또는 "파일 탐색기로 열기" 버튼 클릭 → 파일 선택

**기대 결과**
- `AnalysisPage`로 자동 이동
- 파일 이름, 크기, 형식이 파일 정보 카드에 표시됨

**실패 시 확인**
```bash
# DevTools Console에서 확인
# 또는 로그 파일
grep 'audio:analyze' ~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log
```

**실패 원인 예시**
- `FFPROBE_NOT_FOUND`: ffprobe PATH에 없음 → `ffprobe -version` 확인
- `FILE_CORRUPTED`: 파일 손상 → 다른 파일로 재시도
- `FORMAT_UNSUPPORTED`: 지원하지 않는 코덱 → WAV/FLAC/MP3/AIFF/M4A 사용

---

### [ ] 2. ffprobe 분석 성공 여부

**테스트 방법**
1. WAV 파일 드롭 → AnalysisPage 진입
2. "파일" 카드 내 메타데이터 확인

**기대 결과**
| 항목 | 정상 값 예시 |
|------|-------------|
| 형식 | WAV |
| 샘플레이트 | 44.1 kHz |
| 비트 뎁스 | 24-bit |
| 채널 | Stereo |
| 길이 | 3:42 |
| 크기 | 38.2 MB |

**실패 시 확인**
```bash
# ffprobe 단독 실행으로 파일 자체 검증
ffprobe -v quiet -print_format json -show_streams -show_format /path/to/file.wav

# Python 엔진 직접 테스트
source services/python-audio/.venv/bin/activate
cd services/python-audio
echo '{"id":"test1","method":"analyze","params":{"file_path":"/path/to/file.wav"}}' | python -m app.main
```

---

### [ ] 3. Integrated LUFS 측정 성공 여부

**테스트 방법**
1. AnalysisPage → "라우드니스" 카드
2. "Integrated Loudness" 값 확인

**기대 결과**
- 값이 `-inf`가 아닌 숫자 (예: `-18.3 LUFS`)
- QC 뱃지가 표시됨 (정상/주의/확인 필요)
- 완전한 무음 파일이면 FFmpegError가 발생해야 함 (한국어 에러 메시지 표시)

**CLI로 직접 검증**
```bash
# ffmpeg loudnorm pass1 직접 실행
ffmpeg -hide_banner -i /path/to/file.wav \
  -af "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json" \
  -f null - 2>&1 | python3 -c "
import sys, json
text = sys.stdin.read()
start = text.rfind('{')
end = text.rfind('}') + 1
print(json.loads(text[start:end])['input_i'])
"
```

**실패 시 확인**
```bash
grep 'loudnorm\|LOUDNORM' ~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log
```

---

### [ ] 4. True Peak 측정 성공 여부

**테스트 방법**
1. AnalysisPage → "라우드니스" 카드
2. "True Peak" 값 확인

**기대 결과**
- 숫자 값 (예: `-6.2 dBTP`)
- -0.5 dBTP 초과 시 "확인 필요" 뱃지
- -1.0 ~ -0.5 dBTP 범위 시 "주의" 뱃지

**CLI로 직접 검증**
```bash
ffmpeg -hide_banner -i /path/to/file.wav \
  -af "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json" \
  -f null - 2>&1 | python3 -c "
import sys, json
text = sys.stdin.read()
start = text.rfind('{')
end = text.rfind('}') + 1
data = json.loads(text[start:end])
print(f\"input_tp={data['input_tp']}\")
"
```

---

### [ ] 5. 마스터링 파이프라인 실행 성공 여부

**테스트 방법**
1. AnalysisPage에서 스타일 프리셋 선택 (예: Balanced)
2. "마스터링 시작" 버튼 클릭
3. MasteringPage에서 진행률 관찰

**기대 결과**
- MasteringPage로 전환
- 진행 단계가 순서대로 완료 표시:
  - `파일 검사` → `분석` → `톤 보정` → `Loudness normalization` → `사후 검증`
- 100% 완료 후 ResultPage로 자동 이동
- ResultPage에 Before/After 수치 표시

**파이프라인 단독 테스트 (Python 직접)**
```bash
source services/python-audio/.venv/bin/activate
cd services/python-audio
python3 - <<'EOF'
import json, sys, subprocess, uuid, os

proc = subprocess.Popen(
    ['python', '-m', 'app.main'],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    env={**os.environ, 'PYTHONUNBUFFERED': '1'}
)

# Wait for READY
for line in proc.stderr:
    if 'READY' in line:
        break

req = json.dumps({
    "id": str(uuid.uuid4()),
    "method": "master",
    "params": {
        "input_path": "/path/to/input.wav",
        "output_path": "/tmp/aimaster_test_out.wav",
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

response = proc.stdout.readline()
print(json.dumps(json.loads(response), indent=2, ensure_ascii=False))
proc.terminate()
EOF
```

**실패 시 확인**
```bash
grep '\[pipeline\]\|loudnorm\|ERROR' ~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log
```

---

### [ ] 6. WAV 저장 성공 여부

**테스트 방법 A — Pro 라이선스 있는 경우**
1. ResultPage → "마스터 WAV 저장" 버튼 클릭
2. 저장 대화상자에서 경로 지정
3. 저장된 파일 확인

**테스트 방법 B — 무료 체험 상태 (WAV 잠금 확인)**
1. ResultPage → "마스터 WAV 저장" 버튼이 잠금 아이콘과 함께 비활성화인지 확인
2. 버튼 클릭 시 라이선스 모달이 뜨는지 확인

**저장된 WAV 파일 검증**
```bash
# 저장 후 ffprobe로 포맷 확인
ffprobe -v quiet -show_format -show_streams /path/to/saved_master.wav 2>&1 | grep -E 'codec_name|sample_rate|bits_per|duration'

# 라우드니스 재확인
ffmpeg -hide_banner -i /path/to/saved_master.wav \
  -af "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json" \
  -f null - 2>&1 | python3 -c "
import sys, json
text = sys.stdin.read()
i = text.rfind('{')
d = json.loads(text[i:text.rfind('}')+1])
print(f\"output_i: {d['input_i']} LUFS\")
print(f\"output_tp: {d['input_tp']} dBTP\")
"
```

**기대 결과**
- 파일이 지정 경로에 생성됨
- 비트 뎁스: 24-bit (기본값) 또는 선택한 값
- Integrated LUFS가 -14 ± 1.5 LUFS 범위 이내
- True Peak가 -1.0 dBTP 이하

---

### [ ] 7. QC 결과 출력 성공 여부

**테스트 방법**
1. ResultPage → 상단 TopBar "QC" 버튼 (또는 설정에서 QCPage로 이동)
2. QCPage가 자동으로 QC 분석 실행

**기대 결과**
- 전체 결과 배너 (통과 / 주의 / 실패)
- 검사 항목 목록:
  - LUFS 오차 ±1 dB 이내 → 통과
  - True Peak ≤ -1.0 dBTP → 통과
- 플랫폼 비교 테이블 (Spotify / Apple Music / YouTube)

**QC 단독 테스트**
```bash
source services/python-audio/.venv/bin/activate
cd services/python-audio
echo '{"id":"qc1","method":"qc_check","params":{"file_path":"/path/to/output.wav","target_lufs":-14.0,"target_tp":-1.0}}' \
  | python -m app.main | python3 -m json.tool
```

---

### [ ] 8. 에러 처리 — ffmpeg 없음

**테스트 방법**
```bash
# ffmpeg을 임시로 다른 이름으로 이동
sudo mv /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg.bak
# 앱에서 파일 업로드 시도
# → "FFmpeg를 찾을 수 없습니다" 한국어 에러 + 복구 불가 표시 확인

# 복원
sudo mv /usr/local/bin/ffmpeg.bak /usr/local/bin/ffmpeg
```

**기대 결과**
- 에러 코드: `FFMPEG_NOT_FOUND`
- 메시지: "FFmpeg를 찾을 수 없습니다…"
- 재시도 버튼 없음 (recoverable: false)
- DevTools Console에서 에러 구조 확인: `{ code, userMessage, devDetail, recoverable }`

---

### [ ] 9. 에러 처리 — Python 프로세스 실패

**테스트 방법**
```bash
# 잘못된 Python 경로로 앱 실행
export AIMASTER_PYTHON="/nonexistent/python"
pnpm desktop
# 파일 업로드 시도
```

**기대 결과**
- 에러 코드: `PYTHON_PROCESS_FAILED`
- 재시도 버튼 있음 (recoverable: true)

---

### [ ] 10. 라이선스 무료 → Pro 전환

**테스트 방법**
1. SettingsPage → 라이선스 섹션
2. "라이선스 키 입력" 클릭
3. `AIMASTER-TEST-ABCD-1234` 입력 (v1 LocalValidator — 형식만 체크)
4. "활성화" 클릭

**기대 결과**
- "Pro" 뱃지로 변경
- ResultPage의 "마스터 WAV 저장" 버튼 활성화
- SettingsPage에 키 표시

**라이선스 저장소 직접 확인**
```bash
# electron-store 파일 위치
# macOS
ls ~/Library/Application\ Support/AIMASTER/
# license.json 이 암호화된 상태로 존재
```

---

## 빠른 회귀 체크 (릴리즈 전)

아래 5가지를 순서대로 실행하면 핵심 경로를 모두 커버합니다:

```
[ ] 1. WAV 드롭 → AnalysisPage 표시 (ffprobe 정상)
[ ] 2. "마스터링 시작" → 100% 완료 → ResultPage 표시
[ ] 3. ResultPage 오디오 플레이어에서 MP3 재생 확인
[ ] 4. "프리뷰 MP3 저장" 클릭 → 파일 저장 대화상자 표시
[ ] 5. SettingsPage → 라이선스 활성화 → WAV 저장 버튼 활성화 확인
```
