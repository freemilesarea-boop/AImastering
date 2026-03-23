# AIMASTER Desktop — Product Requirements Document

## Overview
AI 음원 자동 마스터링 데스크톱 애플리케이션.
Suno/Udio 등 AI 생성 음원의 아티팩트를 자동 감지하고 마스터링하여 스트리밍 플랫폼 기준을 충족시킨다.

## Target Users
- AI 음악 생성 크리에이터 (Suno, Udio, Kling)
- 초보 뮤지션 및 홈 레코딩 사용자
- 유튜브 BGM 제작자

## Core User Flow
`파일 업로드 → 분석 → 스타일 프리셋 선택 → 마스터링 → 결과 비교 → 저장`

## Mastering Targets
| Platform       | Integrated LUFS | True Peak |
|---------------|-----------------|-----------|
| YouTube Music | -14 LUFS        | -1.0 dBTP |
| Spotify       | -14 LUFS        | -1.0 dBTP |
| Apple Music   | -16 LUFS        | -1.0 dBTP |
| Amazon Music  | -14 LUFS        | -2.0 dBTP |
| Tidal         | -14 LUFS        | -1.0 dBTP |

## Style Presets
| Preset   | Description                        |
|----------|------------------------------------|
| Balanced | 중립적, 대부분의 장르에 적합         |
| Warm     | 저음 강화, 고음 부드럽게             |
| Bright   | 고음 강화, 선명하고 에너지 있는 사운드 |
| Punch    | 킥/드럼 타격감 강화                 |

## AI Artifact Detection
| Issue             | Threshold                    |
|-------------------|------------------------------|
| Harsh high-mid    | 3–5 kHz energy ratio > 0.28  |
| Boomy low-end     | 60–200 Hz energy ratio > 0.45|
| Brickwall comp    | LRA < 2.5 LU                 |
| Stereo imbalance  | L/R RMS diff > 3 dB          |
| Silence at start  | > 500 ms                     |
| Silence at end    | > 500 ms                     |
| Intersample risk  | True peak > -0.5 dBTP        |
| Upsample suspect  | Nyquist energy heuristic     |

## Free vs Pro
| Feature            | Free         | Pro          |
|--------------------|--------------|--------------|
| 처리 횟수           | 3회          | 무제한        |
| 출력 포맷           | MP3 프리뷰   | WAV 마스터   |
| 스타일 프리셋       | Balanced만   | 전체 4종     |
| QC 리포트 내보내기  | 화면 확인만  | PDF/CSV 저장 |
| 라이선스 키 형식    | —            | AIMASTER-XXXX-XXXX-XXXX |
