// parameter-glossary — Korean names and plain-language explanations.
//
// This app is used by mastering engineers and by people taking a course who
// have never met the word "ratio". Both need the same panel. The English
// term stays, because it is what every other tool and every tutorial calls
// it, and a learner who only ever sees "비율" cannot follow anything else.
// Alongside it goes the Korean name and one sentence of what the control
// actually does, in words that assume no audio training.
//
// Why a separate file rather than fields on each parameter definition:
//
//   • Every translation is in one place to review, so tone stays consistent
//     and a missing entry is obvious at a glance.
//   • The definitions stay about the DSP — range, step, binding — and do
//     not double in size.
//   • Band-repeated parameters collapse. `band0ThresholdDb` through
//     `band3ThresholdDb` are one entry, because they are one idea.
//
// The rule for the plain sentence: say what MOVING it does, not what it is.
// "Threshold: the level above which compression starts" is a definition;
// "이 레벨보다 커진 소리부터 눌러 줄입니다" is an instruction you can act
// on. Where a number has an intuitive reading, give it — 4:1 meaning 4 dB
// over becomes 1 dB over is worth more than any adjective.

import type { ModuleId } from './parameter-state.js';

export interface GlossaryEntry {
  /** Korean name, shown next to the English label. */
  ko: string;
  /** One sentence, in plain Korean, describing what changing it does. */
  plain: string;
}

/**
 * Strip a `bandN` prefix so every band of a module shares one entry.
 * `band2ThresholdDb` → `thresholdDb`; `band0Pct` → `pct`.
 */
export function stripBandPrefix(parameterId: string): string {
  const m = /^band(\d+)(.*)$/.exec(parameterId);
  if (!m || !m[2]) return parameterId;
  const rest = m[2];
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

// ── Module names ─────────────────────────────────────────────────────────

export const MODULE_GLOSSARY: Record<ModuleId, GlossaryEntry> = {
  declick: {
    ko: '클릭 제거',
    plain: '"툭" 하고 튀는 잡음만 찾아내 그 부분을 앞뒤 파형으로 자연스럽게 이어 붙입니다.',
  },
  dehum: {
    ko: '험 노이즈 제거',
    plain: '전원에서 들어온 "우웅—" 하는 저음을 그 주파수와 배음만 골라 깎아냅니다.',
  },
  denoise: {
    ko: '잡음 제거',
    plain: '항상 깔려 있는 "쉬—" 하는 배경 잡음의 크기를 학습해서 그만큼만 걷어냅니다.',
  },
  deess: {
    ko: '치찰음 제거',
    plain: '"ㅅ, ㅊ" 발음에서 쏘는 고음이 튈 때만 잠깐 눌러줍니다.',
  },
  'top-rebuild': {
    ko: '고역 재생성',
    plain: 'AI로 만든 음원에서 번들거리는 고음 구간을 잘라내고, 멀쩡한 중음에서 배음을 만들어 그 자리를 다시 채웁니다.',
  },
  'parametric-eq': {
    ko: '자유 EQ',
    plain: '원하는 주파수를 원하는 만큼 올리거나 내립니다. 점을 추가해 직접 곡선을 그립니다.',
  },
  eq: {
    ko: '기본 EQ',
    plain: '저음·중음·고음의 균형을 잡는 네 개의 기본 조절점입니다.',
  },
  'match-eq': {
    ko: '레퍼런스 매칭',
    plain: '좋아하는 곡의 음색 균형에 내 곡을 가깝게 끌어당깁니다. 복사가 아니라 접근입니다.',
  },
  'spectral-shaper': {
    ko: '거슬림 제어',
    plain: '주변보다 유난히 튀어나온 성분만 그때그때 찾아 눌러, 특정 음에서만 나는 쏘임을 줄입니다.',
  },
  stabilizer: {
    ko: '음색 안정화',
    plain: '곡 전체의 저음-고음 기울기를 목표에 맞춰 일정하게 유지합니다. 레퍼런스가 필요 없습니다.',
  },
  'vintage-eq': {
    ko: '빈티지 EQ',
    plain: '옛 아날로그 EQ의 성질을 흉내 냅니다. 같은 주파수를 올리면서 동시에 깎으면 독특한 저음이 납니다.',
  },
  'dynamic-eq': {
    ko: '다이나믹 EQ',
    plain: '문제가 되는 순간에만 EQ가 걸립니다. 항상 깎지 않고, 너무 커질 때만 깎습니다.',
  },
  multiband: {
    ko: '멀티밴드 컴프레서',
    plain: '저음·중음·고음을 나눠서 각각 따로 눌러줍니다. 킥이 크다고 보컬까지 눌리는 일이 없습니다.',
  },
  dynamics: {
    ko: '글루 컴프레서',
    plain: '곡 전체를 가볍게 눌러 각 악기가 따로 놀지 않고 하나로 붙어 들리게 합니다.',
  },
  'vintage-comp': {
    ko: '빈티지 컴프레서',
    plain: '옛 진공관 컴프레서처럼 세게 들어올수록 더 많이 눌리는 방식입니다. 부드럽게 뭉쳐집니다.',
  },
  impact: {
    ko: '타격감',
    plain: '드럼 같은 소리의 "때리는 첫 순간"을 더 또렷하게 하거나 부드럽게 만듭니다.',
  },
  'low-end-focus': {
    ko: '저역 정리',
    plain: '베이스와 킥이 뭉치는 저음 구간을 또렷하게(Punchy) 또는 고르게(Smooth) 정리합니다.',
  },
  exciter: {
    ko: '엑사이터',
    plain: '없던 배음을 살짝 더해 소리를 화사하거나 따뜻하게 만듭니다. 볼륨이 아니라 색이 바뀝니다.',
  },
  tape: {
    ko: '테이프',
    plain: '아날로그 테이프에 녹음한 느낌 — 저음이 살짝 부풀고 고음이 부드러워집니다.',
  },
  delay: {
    ko: '딜레이 (메아리)',
    plain: '소리를 정해둔 시간만큼 늦춰 다시 들려줍니다. 아주 조금만 섞으면 곡이 넓고 깊어집니다.',
  },
  reverb: {
    ko: '리버브 (공간 울림)',
    plain: '넓은 방에서 들리는 것처럼 소리 뒤에 잔향을 붙입니다. 마스터에서는 2~8% 정도만 씁니다.',
  },
  imager: {
    ko: '스테레오 이미지',
    plain: '소리가 좌우로 얼마나 넓게 퍼질지를 정합니다. 저음은 가운데로 모아 힘을 지킵니다.',
  },
  limiter: {
    ko: '리미터 / 맥시마이저',
    plain: '정해둔 최대 음량을 절대 넘지 않게 막으면서, 전체를 그 한계까지 끌어올립니다.',
  },
  export: {
    ko: '내보내기',
    plain: '최종 파일의 형식·샘플레이트·비트 심도를 정합니다.',
  },
};

// ── Parameters ───────────────────────────────────────────────────────────
//
// Keyed `moduleId.strippedParameterId`.

const G: Record<string, GlossaryEntry> = {
  // ── De-click ──
  'declick.sensitivity': {
    ko: '민감도',
    plain: '높일수록 작은 잡음까지 잡아냅니다. 너무 높이면 멀쩡한 타악기 소리를 잡음으로 오해합니다.',
  },
  'declick.maxRunSamples': {
    ko: '최대 길이',
    plain: '한 번에 고칠 수 있는 잡음의 최대 길이입니다. 이보다 긴 손상은 건드리지 않습니다.',
  },

  // ── De-hum ──
  'dehum.frequencyHz': {
    ko: '전원 주파수',
    plain: '한국·미국은 60 Hz, 유럽·일본 동부는 50 Hz 입니다. 콘센트에서 들어온 잡음의 기준 음입니다.',
  },
  'dehum.depthDb': {
    ko: '깊이',
    plain: '험을 얼마나 깊게 깎을지입니다. 0이면 아무 일도 하지 않습니다.',
  },
  'dehum.harmonics': {
    ko: '배음 개수',
    plain: '험은 기준 음뿐 아니라 그 2배·3배 음에도 있습니다. 몇 배까지 따라가며 지울지 정합니다.',
  },
  'dehum.q': {
    ko: '폭',
    plain: '깎는 폭입니다. 클수록 좁게 깎아 음악을 덜 건드립니다.',
  },
  'dehum.adaptive': {
    ko: '자동 조절',
    plain: '켜면 배음마다 실제 험이 있는 만큼만 깎습니다. 베이스 음이 겹친 자리를 덜 상하게 합니다.',
  },

  // ── De-noise ──
  'denoise.reductionDb': {
    ko: '감쇠량',
    plain: '배경 잡음을 최대 몇 dB까지 줄일지입니다. 과하면 소리가 물속처럼 먹먹해집니다.',
  },
  'denoise.thresholdDb': {
    ko: '판정 기준',
    plain: '올리면 더 많은 소리를 잡음으로 봅니다. 잡음이 남으면 올리고, 소리가 상하면 내리세요.',
  },
  'denoise.sharpness': {
    ko: '강도',
    plain: '잡음과 소리를 얼마나 칼같이 나눌지입니다. 높이면 깨끗하지만 "찰랑"거리는 인공음이 생깁니다.',
  },
  'denoise.smoothing': {
    ko: '부드러움',
    plain: '처리 변화를 시간축으로 완만하게 만듭니다. 인공음이 거슬리면 올리세요.',
  },
  'denoise.autoProfile': {
    ko: '자동 학습',
    plain: '조용한 구간을 스스로 찾아 잡음의 크기를 추정합니다. 끄면 직접 학습시켜야 합니다.',
  },

  // ── De-esser ──
  'deess.frequencyHz': {
    ko: '동작 주파수',
    plain: '이 주파수보다 높은 소리에서 치찰음을 찾습니다. 보통 여성 보컬 6~8 kHz, 남성 5~7 kHz 입니다.',
  },
  'deess.rangeDb': {
    ko: '최대 감쇠',
    plain: '가장 심할 때 몇 dB까지 눌러줄지의 한계입니다.',
  },
  'deess.thresholdDb': {
    ko: '작동 기준',
    plain: '이 크기를 넘는 치찰음부터 누릅니다. 내릴수록 자주 걸립니다.',
  },
  'deess.ratio': {
    ko: '누르는 비율',
    plain: '기준을 넘은 만큼을 얼마로 줄일지입니다. 4:1이면 4 dB 넘어온 것을 1 dB만 넘게 만듭니다.',
  },
  'deess.attackMs': {
    ko: '반응 속도',
    plain: '치찰음이 시작되고 몇 ms 만에 누르기 시작할지입니다. 짧을수록 빨리 잡지만 딱딱해집니다.',
  },
  'deess.releaseMs': {
    ko: '회복 속도',
    plain: '치찰음이 끝난 뒤 몇 ms 만에 원래대로 돌아올지입니다.',
  },
  'deess.wideband': {
    ko: '전대역 모드',
    plain: '켜면 치찰음이 날 때 소리 전체를 낮춥니다. 끄면 고음만 낮춰 더 자연스럽습니다.',
  },

  // ── Top Rebuild ──
  'top-rebuild.amountPct': {
    ko: '적용량',
    plain: '망가진 고음을 얼마나 새 소리로 바꿀지입니다. 0이면 꺼짐, 100이면 전부 교체합니다. 보통 60~80% 입니다.',
  },
  'top-rebuild.crossoverHz': {
    ko: '손상 시작',
    plain: '이 주파수 위가 망가졌다고 보고 새로 만듭니다. 번들거림이 남으면 내리고, 심벌이 이상해지면 올리세요.',
  },
  'top-rebuild.sourceHz': {
    ko: '재료 주파수',
    plain: '새 고음을 만들 재료가 되는 멀쩡한 중음대입니다. 보컬이면 4~5 kHz 근처가 목소리의 성격을 잘 옮깁니다.',
  },
  'top-rebuild.characterPct': {
    ko: '성격',
    plain: '높이면 더 높은 곳까지 밝게 채우고, 낮추면 낮은 쪽에 두툼하게 채웁니다. 쏘면 내리세요.',
  },
  'top-rebuild.followMs': {
    ko: '따라가기',
    plain: '새로 만든 고음이 원래 소리의 크기를 얼마나 빠르게 따라갈지입니다. 짧으면 또렷하고, 길면 부드럽습니다.',
  },

  // ── EQ ──
  'eq.lowCutHz': {
    ko: '저역 차단',
    plain: '이 주파수 아래를 잘라냅니다. 눈에 안 보이는 초저음 울림을 없애 소리가 정리됩니다. 20 Hz면 꺼짐입니다.',
  },
  'eq.lowCutQ': {
    ko: '차단 곡률',
    plain: '자르는 지점의 성격입니다. 높이면 자르기 직전이 살짝 부풀어 힘이 붙습니다.',
  },
  'eq.lowShelfHz': { ko: '저역 기준', plain: '저음을 올리고 내릴 기준 주파수입니다.' },
  'eq.lowShelfDb': {
    ko: '저역',
    plain: '기준보다 낮은 음 전체를 함께 올리거나 내립니다. 무게감을 조절합니다.',
  },
  'eq.lowShelfQ': { ko: '저역 기울기', plain: '저음이 얼마나 완만하게 올라가는지입니다.' },
  'eq.presenceHz': {
    ko: '중고역 기준',
    plain: '어느 주파수를 집중해서 건드릴지입니다. 보컬의 존재감은 보통 2~4 kHz 입니다.',
  },
  'eq.presenceDb': {
    ko: '중고역',
    plain: '그 주파수 주변만 봉긋하게 올리거나 파냅니다. 올리면 또렷해지고 내리면 뒤로 물러납니다.',
  },
  'eq.presenceQ': {
    ko: '중고역 폭',
    plain: '건드리는 폭입니다. 높이면 좁고 정확하게, 낮추면 넓고 자연스럽게 움직입니다.',
  },
  'eq.airHz': { ko: '고역 기준', plain: '고음을 올리고 내릴 기준 주파수입니다.' },
  'eq.airDb': {
    ko: '고역(공기감)',
    plain: '기준보다 높은 음 전체를 올리거나 내립니다. 올리면 반짝이고 시원해집니다.',
  },
  'eq.airQ': { ko: '고역 기울기', plain: '고음이 얼마나 완만하게 올라가는지입니다.' },
  'eq.outputGainDb': {
    ko: '출력 음량',
    plain: 'EQ를 거친 뒤 전체 음량을 맞춥니다. EQ로 올린 만큼 여기서 내리면 공정한 비교가 됩니다.',
  },
  'eq.adaptive': {
    ko: '거슬림 완화',
    plain: '켜면 귀에 쏘이기 쉬운 4 kHz 부근을 아주 살짝 눌러줍니다.',
  },

  // ── Match EQ ──
  'match-eq.amountPct': {
    ko: '적용량',
    plain: '레퍼런스와의 차이를 몇 % 만큼 따라갈지입니다. 100%는 완전히 맞추기, 50%는 절반만 다가가기입니다.',
  },
  'match-eq.maxMoveDb': {
    ko: '최대 보정',
    plain: '한 구간을 최대 몇 dB까지 움직일지의 한계입니다. 과한 보정을 막습니다.',
  },
  'match-eq.smoothingBands': {
    ko: '부드러움',
    plain: '보정을 매끄러운 곡선으로 만듭니다. 낮으면 빗살처럼 들쭉날쭉해집니다.',
  },

  // ── Spectral Shaper ──
  'spectral-shaper.amountPct': {
    ko: '적용량',
    plain: '튀어나온 부분을 몇 % 만큼 눌러 내릴지입니다.',
  },
  'spectral-shaper.thresholdDb': {
    ko: '판정 기준',
    plain: '주변보다 몇 dB 이상 튀어야 "거슬림"으로 볼지입니다. 낮출수록 자주 걸립니다.',
  },
  'spectral-shaper.lowHz': { ko: '시작 주파수', plain: '이 주파수부터 위로만 살펴봅니다.' },
  'spectral-shaper.highHz': { ko: '끝 주파수', plain: '이 주파수까지만 살펴봅니다.' },
  'spectral-shaper.blurBins': {
    ko: '비교 범위',
    plain: '"주변"을 얼마나 넓게 볼지입니다. 넓으면 큰 덩어리만, 좁으면 뾰족한 것만 잡습니다.',
  },

  // ── Stabilizer ──
  'stabilizer.amountPct': {
    ko: '적용량',
    plain: '목표 기울기 쪽으로 얼마나 강하게 끌어당길지입니다.',
  },
  'stabilizer.tiltDbPerOct': {
    ko: '목표 기울기',
    plain: '고음으로 갈수록 얼마나 줄어들지입니다. 음수가 어두운 쪽이고, 대중음악은 보통 −1.5 근처입니다.',
  },
  'stabilizer.maxMoveDb': {
    ko: '최대 보정',
    plain: '한 구간을 최대 몇 dB까지 움직일지의 한계입니다.',
  },

  // ── Vintage EQ ──
  'vintage-eq.lowFrequencyHz': {
    ko: '저역 기준',
    plain: '저음을 올리고 깎는 기준점입니다. 올리는 자리와 깎는 자리가 이 값을 함께 따라갑니다.',
  },
  'vintage-eq.lowBoostDb': {
    ko: '저역 부스트',
    plain: '기준 아래 저음을 들어올립니다. 이 노브는 올리는 방향으로만 움직입니다.',
  },
  'vintage-eq.lowCutDb': {
    ko: '저역 감쇠',
    plain: '기준보다 살짝 위를 파냅니다. 부스트와 같이 쓰면 저음은 살고 지저분한 부분만 빠집니다.',
  },
  'vintage-eq.highFrequencyHz': { ko: '고역 기준', plain: '고음을 올릴 기준 주파수입니다.' },
  'vintage-eq.highBoostDb': { ko: '고역 부스트', plain: '기준 주파수 주변을 들어올려 화사하게 만듭니다.' },
  'vintage-eq.highBandwidth': {
    ko: '고역 폭',
    plain: '고역 부스트가 얼마나 넓게 퍼질지입니다. 좁으면 뾰족하게, 넓으면 자연스럽게 올라갑니다.',
  },
  'vintage-eq.highCutDb': { ko: '고역 감쇠', plain: '아주 높은 음을 부드럽게 깎아 날카로움을 없앱니다.' },

  // ── Dynamic EQ (one entry per band idea) ──
  'dynamic-eq.enabled': { ko: '사용', plain: '이 밴드를 켜고 끕니다.' },
  'dynamic-eq.shape': {
    ko: '모양',
    plain: 'Bell은 그 주변만, Low/High shelf는 그 아래·위 전체를 움직입니다.',
  },
  'dynamic-eq.mode': {
    ko: '방향',
    plain: 'Down은 커질 때 깎고, Up은 작아질 때 올립니다.',
  },
  'dynamic-eq.frequencyHz': { ko: '주파수', plain: '어느 음높이를 감시할지입니다.' },
  'dynamic-eq.q': { ko: '폭', plain: '건드리는 폭입니다. 높을수록 좁고 정확합니다.' },
  'dynamic-eq.thresholdDb': {
    ko: '작동 기준',
    plain: '이 크기를 넘으면 EQ가 걸리기 시작합니다. 평소에는 아무 일도 하지 않습니다.',
  },
  'dynamic-eq.ratio': {
    ko: '비율',
    plain: '기준을 넘은 만큼을 얼마로 줄일지입니다. 숫자가 클수록 강하게 눌립니다.',
  },
  'dynamic-eq.rangeDb': { ko: '최대 이동', plain: '이 밴드가 움직일 수 있는 최대 dB 입니다.' },
  'dynamic-eq.attackMs': { ko: '반응 속도', plain: '문제가 생기고 몇 ms 만에 걸리기 시작할지입니다.' },
  'dynamic-eq.releaseMs': { ko: '회복 속도', plain: '문제가 사라진 뒤 몇 ms 만에 원래대로 돌아올지입니다.' },

  // ── Multiband ──
  'multiband.crossover1Hz': { ko: '저역/중저역 경계', plain: '저음 밴드와 중저음 밴드를 나누는 지점입니다.' },
  'multiband.crossover2Hz': { ko: '중저역/중고역 경계', plain: '중저음과 중고음을 나누는 지점입니다.' },
  'multiband.crossover3Hz': { ko: '중고역/고역 경계', plain: '중고음과 고음을 나누는 지점입니다.' },
  'multiband.mode': {
    ko: '방향',
    plain: 'Compress는 큰 소리를 눌러 고르게, Expand는 작은 소리를 더 낮춰 또렷하게 만듭니다.',
  },
  'multiband.thresholdDb': {
    ko: '작동 기준',
    plain: '이 크기를 넘는 소리부터 눌립니다. 내릴수록 더 자주, 더 많이 걸립니다.',
  },
  'multiband.ratio': {
    ko: '비율',
    plain: '기준을 넘은 만큼을 얼마로 줄일지입니다. 4:1이면 4 dB 넘어온 것이 1 dB만 넘습니다. 1:1은 꺼짐입니다.',
  },
  'multiband.attackMs': {
    ko: '반응 속도',
    plain: '소리가 커지고 몇 ms 만에 누르기 시작할지입니다. 짧으면 타격감이 줄고, 길면 첫 순간이 살아납니다.',
  },
  'multiband.releaseMs': {
    ko: '회복 속도',
    plain: '소리가 잦아든 뒤 몇 ms 만에 손을 뗄지입니다. 짧으면 출렁이고, 길면 차분합니다.',
  },
  'multiband.makeupDb': {
    ko: '보상 음량',
    plain: '눌러서 줄어든 만큼 다시 올려줍니다. 처리 전후 음량을 맞출 때 씁니다.',
  },
  'multiband.mixPct': {
    ko: '섞는 비율',
    plain: '누른 소리와 원래 소리를 섞습니다. 100%보다 낮추면 원래의 생생함이 남습니다(병렬 압축).',
  },
  'multiband.solo': { ko: '이 밴드만 듣기', plain: '이 대역만 들어봅니다. 설정용이며 저장에는 영향이 없습니다.' },
  'multiband.mute': { ko: '이 밴드 끄기', plain: '이 대역만 빼고 들어봅니다.' },

  // ── Dynamics (glue) ──
  'dynamics.thresholdDb': {
    ko: '작동 기준',
    plain: '이 크기를 넘는 소리부터 눌립니다. 내릴수록 더 자주 걸립니다.',
  },
  'dynamics.ratio': {
    ko: '비율',
    plain: '기준을 넘은 만큼을 얼마로 줄일지입니다. 2:1이면 2 dB 넘어온 것이 1 dB만 넘습니다. 곡을 하나로 붙일 땐 2:1 정도가 무난합니다.',
  },
  'dynamics.attackMs': {
    ko: '반응 속도',
    plain: '소리가 커지고 몇 ms 만에 누르기 시작할지입니다. 길게 두면 드럼의 때리는 맛이 살아남습니다.',
  },
  'dynamics.releaseMs': {
    ko: '회복 속도',
    plain: '소리가 잦아든 뒤 몇 ms 만에 손을 뗄지입니다. 곡의 박자에 맞으면 자연스럽게 숨쉬듯 들립니다.',
  },
  'dynamics.mixPct': {
    ko: '섞는 비율',
    plain: '누른 소리와 원래 소리를 섞습니다. 낮추면 눌렀는데도 생생함이 남습니다.',
  },

  // ── Vintage comp ──
  'vintage-comp.thresholdDb': { ko: '작동 기준', plain: '이 크기를 넘는 소리부터 눌리기 시작합니다.' },
  'vintage-comp.ratio': {
    ko: '최대 비율',
    plain: '가장 세게 들어올 때의 압축 비율입니다. 진공관식이라 작게 들어오면 저절로 약하게 걸립니다.',
  },
  'vintage-comp.attackMs': { ko: '반응 속도', plain: '소리가 커지고 몇 ms 만에 누르기 시작할지입니다.' },
  'vintage-comp.characterPct': {
    ko: '성격',
    plain: '올릴수록 옛 기기 특유의 배음과 뭉침이 강해집니다. 0이면 담백합니다.',
  },
  'vintage-comp.makeupDb': { ko: '보상 음량', plain: '눌러서 줄어든 만큼 다시 올려줍니다.' },
  'vintage-comp.mixPct': { ko: '섞는 비율', plain: '누른 소리와 원래 소리를 섞습니다.' },

  // ── Impact ──
  'impact.crossover1Hz': { ko: '저역/중저역 경계', plain: '타격감을 따로 조절할 대역을 나누는 지점입니다.' },
  'impact.crossover2Hz': { ko: '중저역/중고역 경계', plain: '타격감을 따로 조절할 대역을 나누는 지점입니다.' },
  'impact.crossover3Hz': { ko: '중고역/고역 경계', plain: '타격감을 따로 조절할 대역을 나누는 지점입니다.' },
  'impact.pct': {
    ko: '타격감',
    plain: '양수면 때리는 첫 순간이 도드라지고, 음수면 부드러워집니다. 0이면 그대로입니다.',
  },

  // ── Low End Focus ──
  'low-end-focus.mode': {
    ko: '방식',
    plain: 'Punchy는 저음의 때리는 맛을 살리고, Smooth는 울렁임을 고르게 다립니다.',
  },
  'low-end-focus.frequencyHz': { ko: '기준 주파수', plain: '이 주파수 아래를 저역으로 보고 처리합니다.' },
  'low-end-focus.contrastPct': {
    ko: '대비',
    plain: '저음의 세고 약한 차이를 얼마나 벌릴지입니다. 크기가 아니라 "리듬감"이 바뀝니다.',
  },
  'low-end-focus.gainDb': { ko: '저역 음량', plain: '저역만 올리거나 내립니다.' },

  // ── Exciter ──
  'exciter.mode': {
    ko: '색깔',
    plain: 'Warm은 두툼하게, Tube·Triode는 진공관처럼, Tape는 테이프처럼, Retro는 거칠게 물듭니다.',
  },
  'exciter.crossover1Hz': { ko: '저역/중저역 경계', plain: '색을 따로 입힐 대역을 나누는 지점입니다.' },
  'exciter.crossover2Hz': { ko: '중저역/중고역 경계', plain: '색을 따로 입힐 대역을 나누는 지점입니다.' },
  'exciter.crossover3Hz': { ko: '중고역/고역 경계', plain: '색을 따로 입힐 대역을 나누는 지점입니다.' },
  'exciter.pct': {
    ko: '양',
    plain: '이 대역에 배음을 얼마나 더할지입니다. 음량은 자동으로 맞춰지므로 커지지 않고 색만 바뀝니다.',
  },
  'exciter.driveDb': { ko: '드라이브', plain: '전체적으로 얼마나 세게 밀어 넣을지입니다. 클수록 배음이 진해집니다.' },
  'exciter.outputDb': { ko: '출력 음량', plain: '처리 후 전체 음량을 맞춥니다.' },

  // ── Tape ──
  'tape.speed': {
    ko: '테이프 속도',
    plain: '느릴수록 저음이 부풀고 색이 진해집니다. 30 ips가 가장 깨끗하고 7.5 ips가 가장 진합니다.',
  },
  'tape.mixPct': { ko: '섞는 비율', plain: '테이프를 거친 소리와 원래 소리를 섞습니다.' },
  'tape.driveDb': { ko: '드라이브', plain: '테이프에 얼마나 세게 밀어 넣을지입니다. 클수록 따뜻하게 뭉개집니다.' },
  'tape.bias': {
    ko: '바이어스',
    plain: '테이프의 동작점입니다. 저음이 부푸는 정도와 고음이 깎이는 정도가 함께 바뀝니다.',
  },
  'tape.wowFlutterPct': {
    ko: '떨림',
    plain: '옛 테이프의 미세한 음정 흔들림입니다. 조금이면 사람 냄새가 나고, 많으면 어지럽습니다.',
  },

  // ── Delay ──
  'delay.mixPct': {
    ko: '섞는 양',
    plain: '메아리를 얼마나 들리게 할지입니다. 0이면 꺼짐이고, 마스터에서는 5~15% 면 충분합니다.',
  },
  'delay.timeMs': {
    ko: '시간',
    plain: '원래 소리보다 몇 ms 늦게 메아리가 올지입니다. 짧으면 넓어지는 느낌, 길면 또렷한 메아리가 됩니다.',
  },
  'delay.stereoOffsetPct': {
    ko: '좌우 시차',
    plain: '오른쪽 메아리를 왼쪽보다 얼마나 늦출지입니다. 0이 아니면 소리가 좌우로 벌어집니다.',
  },
  'delay.feedbackPct': {
    ko: '반복',
    plain: '메아리를 다시 입력으로 되돌려 몇 번 더 울릴지입니다. 높을수록 오래 반복합니다.',
  },
  'delay.dampingHz': {
    ko: '고역 감쇠',
    plain: '반복될 때마다 이 주파수 위가 깎입니다. 낮출수록 메아리가 점점 어두워져 자연스럽습니다.',
  },
  'delay.lowCutHz': {
    ko: '저역 차단',
    plain: '메아리에서 이 주파수 아래를 뺍니다. 베이스가 메아리로 겹쳐 지저분해지는 걸 막습니다.',
  },
  'delay.pingPong': {
    ko: '핑퐁',
    plain: '켜면 메아리가 좌–우–좌–우 번갈아 튑니다. 넓게 퍼지지만 모노에서는 효과가 줄어듭니다.',
  },

  // ── Reverb ──
  'reverb.mixPct': {
    ko: '섞는 양',
    plain: '잔향을 얼마나 들리게 할지입니다. 0이면 꺼짐이고, 마스터에서는 2~8% 를 넘기면 곡이 흐려집니다.',
  },
  'reverb.sizePct': {
    ko: '공간 크기',
    plain: '방이 얼마나 큰지 — 즉 울림이 얼마나 오래 남는지입니다. 키우면 성당처럼, 줄이면 작은 방처럼 됩니다.',
  },
  'reverb.dampingPct': {
    ko: '고역 감쇠',
    plain: '울림의 높은 음이 얼마나 빨리 사라질지입니다. 올리면 부드럽고 따뜻하게, 내리면 밝고 길게 남습니다.',
  },
  'reverb.widthPct': {
    ko: '울림 폭',
    plain: '잔향이 좌우로 얼마나 벌어질지입니다. 줄이면 가운데로 모여 원래 소리를 덜 가립니다.',
  },
  'reverb.preDelayMs': {
    ko: '시작 지연',
    plain: '소리가 난 뒤 몇 ms 있다가 울림이 시작될지입니다. 두면 드럼의 때리는 순간이 흐려지지 않습니다.',
  },
  'reverb.lowCutHz': {
    ko: '저역 차단',
    plain: '울림에서 이 주파수 아래를 뺍니다. 저음이 울리면 곡 전체가 먹먹해지므로 보통 200~300 Hz 로 둡니다.',
  },

  // ── Imager ──
  'imager.widthPct': {
    ko: '스테레오 폭',
    plain: '100%가 원래대로입니다. 넘기면 좌우로 넓어지고, 줄이면 가운데로 모입니다.',
  },
  'imager.lowMonoHz': {
    ko: '저역 모노 기준',
    plain: '이 주파수 아래는 좌우를 합쳐 가운데로 모읍니다. 저음이 힘을 잃지 않게 하는 표준 처리입니다.',
  },
  'imager.stereoize': {
    ko: '넓힘 방식',
    plain: '모노에 가까운 소리를 인위적으로 벌릴지 여부입니다. 과하면 모노로 들을 때 소리가 사라질 수 있습니다.',
  },
  'imager.bandLowPct': { ko: '저역 폭', plain: '저음 대역만 따로 넓히거나 좁힙니다.' },
  'imager.bandMidLowPct': { ko: '중저역 폭', plain: '중저음 대역만 따로 넓히거나 좁힙니다.' },
  'imager.bandMidHighPct': { ko: '중고역 폭', plain: '중고음 대역만 따로 넓히거나 좁힙니다.' },
  'imager.bandHighPct': { ko: '고역 폭', plain: '고음 대역만 따로 넓히거나 좁힙니다.' },

  // ── Limiter / Maximizer ──
  'limiter.targetLufs': {
    ko: '목표 음량',
    plain: '곡 전체의 평균 음량 목표입니다. 스트리밍은 보통 −14, 클럽·힙합은 더 큰 값을 씁니다. 숫자가 클수록(0에 가까울수록) 큽니다.',
  },
  'limiter.autoGain': {
    ko: '자동 음량 맞춤',
    plain: '켜면 목표 음량에 맞춰 자동으로 볼륨을 올리거나 내립니다. 들으면서 바로 반영됩니다. 끄면 아래 Drive로 직접 조절합니다.',
  },
  'limiter.maxBoostDb': {
    ko: '최대 증폭 한도',
    plain: '자동 음량 맞춤이 최대 몇 dB까지 올릴 수 있는지입니다. 아주 작게 녹음된 곡을 무리하게 키우는 것을 막아줍니다.',
  },
  'limiter.driveDb': {
    ko: '밀어넣기 (음압)',
    plain: '리미터에 소리를 얼마나 세게 밀어 넣을지입니다. 올릴수록 커지고 단단해지지만, 너무 올리면 답답하고 숨이 막힙니다.',
  },
  'limiter.ceilingDbtp': {
    ko: '최대 한계',
    plain: '절대 넘지 않을 최고 음량입니다. −1.0 정도로 두면 변환 과정에서 소리가 깨지지 않습니다. 조용한 곡에서는 이 값을 내려도 소리가 안 변하는 게 정상입니다 — 한계에 닿는 소리가 없으니까요.',
  },
  'limiter.isp': {
    ko: '트루 피크 감시',
    plain: '켜면 파일에는 안 보이지만 재생할 때 생기는 초과분까지 막습니다. 스트리밍 업로드 시 켜두세요.',
  },
  'limiter.lookaheadMs': {
    ko: '미리 보기',
    plain: '소리가 오기 전에 미리 알고 대비하는 시간입니다. 길수록 깨끗하지만 지연이 늘어납니다.',
  },
  'limiter.character': {
    ko: '성격',
    plain: 'Clean은 투명하게, Punchy는 힘 있게, Smooth는 부드럽게, Aggressive는 크고 거칠게 눌립니다.',
  },

  // ── Export ──
  'export.format': { ko: '파일 형식', plain: 'WAV는 무손실, MP3는 용량이 작지만 음질이 조금 깎입니다.' },
  'export.sampleRate': {
    ko: '샘플레이트',
    plain: '1초를 몇 조각으로 기록할지입니다. 보통은 원본과 같게 두면 됩니다.',
  },
  'export.bitDepth': {
    ko: '비트 심도',
    plain: '음량의 해상도입니다. 24비트가 표준이고, CD는 16비트입니다.',
  },
  'export.dither': {
    ko: '디더',
    plain: '비트를 줄일 때 생기는 거친 왜곡을 아주 작은 잡음으로 감춥니다. 16비트로 내보낼 때만 의미가 있습니다.',
  },
  'export.ditherAutoBlank': {
    ko: '무음 구간 제외',
    plain: '완전한 무음에서는 디더 잡음도 끕니다. 곡 시작 전 정적이 깨끗해집니다.',
  },
};

/** Korean name + plain explanation for a parameter, if one exists. */
export function glossaryFor(moduleId: string, parameterId: string): GlossaryEntry | undefined {
  return G[`${moduleId}.${stripBandPrefix(parameterId)}`];
}

/** Every glossary key, for the coverage test. */
export const GLOSSARY_KEYS: readonly string[] = Object.keys(G);
