# Louver Mastering AI v3.6.0 — Release Draft

> 이 파일은 GitHub Actions `release-draft` job 이 GitHub Release 본문으로
> 사용합니다 (`body_path`).  RC 단계에서는 `RELEASE_NOTES_v3.6.0.md` 의
> 내용을 그대로 미러합니다.  정식 v3.6.0 으로 승격할 때 이 파일도 함께
> 업데이트하세요.

이 빌드의 사용자 대상 변경 사항은 다음 문서를 참조하세요:

→ [`RELEASE_NOTES_v3.6.0.md`](./RELEASE_NOTES_v3.6.0.md)

QA 진행 체크리스트:

→ [`QA_v3.6_RC.md`](./QA_v3.6_RC.md)

---

## Highlights

- Phase-A 보안 하드닝 — `LICENSE_HMAC_SECRET` 환경변수화, release smoke
  script 가 production 빌드에서 시크릿 누락을 감지.
- v3.5 결과 페이지 UI wiring 안정화 — null-safe 렌더링, 7-mode 동기화.
- mono-safe stereo enhancement — 1ch 입력에서 NaN / inf 발생 안 함.
- Phase-D 분석 → Phase-E UI 의 첫 end-to-end 노출:
  - Section Analysis (verse/chorus 타임라인 + DR + 대비 점수)
  - AI Artifact Check (위상 / 금속성 / 서브 럼블 가능성)
  - Vocal Intelligence (보컬 명료도 / mood / sibilance)
  - Translation Check (폰 / 노트북 / 클럽 예측)
  - Smart Recommendation (3–5 권장 사항, danger → warn → info)
  - Exportable Mastering Report (TXT + JSON, schema `phase-e/1`)

## ⚠️ 알려진 한계

- macOS 코드 서명 / Notarization 미적용 (v3.6.x 예정).
- LoudnessMeterPanel (live meter) 은 컴포넌트만 존재하고 페이지에 미연결.
- Phase-D Python emit 일부는 v3.6.x 패치에서 마무리 (UI fallback-safe).

## 자동 업데이트 정상 조건

| 플랫폼 | 자동 업데이트 |
|--------|:-------------:|
| Windows NSIS installer | ✅ 정상 |
| Linux AppImage | ✅ 정상 |
| macOS DMG / ZIP | ❌ 코드 서명 미완 |

또한 build 자체가:
- `app.isPackaged === true`
- `__AUTO_UPDATE_ENABLED__ === true` (= git tag `v*` push 빌드)

→ 두 조건이 모두 충족될 때만 GitHub Releases 를 query 합니다.
