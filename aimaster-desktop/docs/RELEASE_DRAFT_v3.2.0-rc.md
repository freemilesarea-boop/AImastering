# Louver Mastering AI v3.2.0-rc

> **Pre-release** — 정식 v3.2.0 직전 후보 빌드 (Release Candidate). 정식
> 배포 전 실 음원 6 종 수동 회귀 (`docs/MANUAL_TEST_CHECKLIST_v3.2.0-rc.md`)
> 통과 확인 후 v3.2.0 태깅 권장.

---

## 다운로드

| Platform              | Architecture       | File                                                       |
|-----------------------|--------------------|------------------------------------------------------------|
| macOS — Apple Silicon | arm64              | `Louver-Mastering-AI-3.2.0-rc-mac-arm64.zip`               |
| macOS — Intel         | x64                | `Louver-Mastering-AI-3.2.0-rc-mac-x64.zip`                 |
| Windows               | x64 (portable)     | `Louver-Mastering-AI-3.2.0-rc-portable-x64.exe`            |
| Linux                 | x64 (AppImage)     | `Louver-Mastering-AI-3.2.0-rc-linux-x86_64.AppImage`       |

> macOS — 첫 실행 시 Finder 에서 앱을 우클릭 → "열기" 를 선택하세요. 본 RC
> 는 codesign 미적용입니다.
>
> Windows — 압축 해제 후 portable `.exe` 를 직접 실행하세요. 설치형 (NSIS)
> 은 정식 v3.2.0 에서 제공합니다.

---

## Highlights

- **R1** — correction pass push 정확도 수정. high-LUFS 모드 (`loud`,
  `kpop_loud`) 에서 LUFS 가 목표값 부근으로 수렴하도록 보정 게인 한도를
  ±6 → ±12 dB 로 확장하고, 보정 단계 alimiter 의 input gain 중복 적용 버그를
  수정.
- **R2** — Dynamic EQ ffmpeg 7 호환. 패키징된 `ffmpeg-static` 7.0.2 의
  `adynamicequalizer` mode enum 변경 (`cut/boost` → `cutbelow/cutabove/...`)
  을 런타임에 자동 감지. sibilance / kpop_loud LUFS 가 최대 +2.6 LU 개선됨.
- **결과 패널 신규 카드** — Waveform PNG (before / after / compare),
  metric comparison 표 (7~8 행), quality check (overall + 항목별), dynamic
  EQ 설정 (엔진 / intensity / 밴드).
- **High-LUFS 정적 체인** — `loud` / `kpop_loud` / `target_lufs > -12` 에서
  단일 ffmpeg pass 로 EQ → Dyn EQ → Compressor → Soft clip → Limiter 처리해
  short-term envelope 출렁임 제거.
- **ISP safety pass** — 최종 측정 TP 가 ceiling 초과 시 자동 추가 attenuation,
  보고에 `ispCorrectionDb` 노출.
- **TypeScript strict + exactOptionalPropertyTypes** — 4 패키지 monorepo
  처음으로 통과.

## Bug fixes

| ID  | 내용 |
|-----|------|
| R1  | correction pass alimiter `level_in` 중복 적용으로 LUFS push 부족 |
| R2  | ffmpeg 7 의 adynamicequalizer `mode=cut` invalid argument |
| —   | `LoudnessStats` re-export 누락 |
| —   | `FFmpegStatus.version` exactOptional 위반 |
| —   | `node-machine-id` 시그니처 (`{ original: true }` → `true`) |
| —   | `LicenseInfo.expiresAt` exactOptional 위반 |
| —   | `import.meta.env` 인식 (`vite/client` reference) |

## QA 결과 요약

active engine 회귀 (26 runs, host ffmpeg 6.1) — TP failures **0**,
qc danger 5 → **3**, dynamic_eq 활성 24/26.

high-LUFS / low-input 케이스 LUFS (target):

| mode      | sample      | target | baseline | RC     |
|-----------|-------------|-------:|---------:|-------:|
| loud      | low_lufs    | -10.0  | -12.28   | -10.28 |
| loud      | bass_heavy  | -10.0  |  -6.25   |  -8.99 |
| kpop_loud | low_lufs    |  -9.0  | -10.45   |  -8.45 |
| kpop_loud | bass_heavy  |  -9.0  |  -5.35   |  -8.99 |

packaged ffmpeg 7 smoke (R2 fix 후):

| mode      | sample        | target | host ff6 (R1) | packaged ff7 (R2) |
|-----------|---------------|-------:|--------------:|------------------:|
| loud      | sibilant      | -10.0  | -14.26        | **-11.66**        |
| kpop_loud | sibilant      |  -9.0  | -12.96        | **-10.66**        |

## Known issues

- **K-1**: 합성 sibilant 픽스처에서 loud / kpop_loud 결과가 목표보다 약 1.6
  LU under. 실 음원에서는 발생 가능성 낮음 — 실음원 검증 후 재평가.
- **K-2**: Linux 호스트에서 Windows cross-build 미지원 → Windows runner 필요.
- **K-3**: macOS codesign / notarization 은 macOS runner 에서 별도 sign 필요.
- **K-4**: NSIS installer 일시 비활성화 (Windows MAX_PATH 제약). 정식 v3.2.0
  에서 NSIS 경로 단축 우회 적용 후 재제공 예정.
- **K-5**: macOS DMG 비활성화 (CI hdiutil 실패) — zip 만 ship.

자세한 내용은 [`RELEASE_NOTES_v3.2.0-rc.md`](./RELEASE_NOTES_v3.2.0-rc.md)
참조.

## Sign-off 체크리스트 (정식 v3.2.0 태깅 전)

- [ ] 실 음원 6 종 수동 회귀 — `MANUAL_TEST_CHECKLIST_v3.2.0-rc.md` 모든 항목 ✅
- [ ] Windows runner 에서 portable `.exe` 빌드 (현재 RC 는 Linux cross-build 실패)
- [ ] macOS runner 에서 zip codesign + notarization
- [ ] 사용자 베타 1 인 이상 실제 곡 마스터링 후 청감 OK
