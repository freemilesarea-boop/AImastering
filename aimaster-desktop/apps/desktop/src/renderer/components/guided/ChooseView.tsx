// Guided flow — Choose screen (PROTOTYPE-PORT T4).
//
// The "three picks": Style · Intensity · Target.  Maps the choices onto the
// existing audioStore.options (no DSP/IPC change) and hands off to the
// existing MasteringPage via setPage('mastering').
//
// Intensity rules (approved):
//   Standard → limiterStrength 'medium'; targetLufs = style/target default.
//   Strong   → limiterStrength 'high';  targetLufs +1 LU louder,
//              EXCEPT KPOP Loud (already aggressive) → limiter only.
import React, { useCallback, useState } from 'react';
import type { MasteringStyle, LimiterStrength } from '@aimaster/shared-types';
import { useAppStore } from '../../stores/appStore.js';
import { useAudioStore } from '../../stores/audioStore.js';
import StyleCard from './StyleCard.js';
import SegToggle from './SegToggle.js';
import TargetCard from './TargetCard.js';
import CtaButton from './CtaButton.js';

type StyleChoice = 'balanced' | 'loud' | 'kpop_loud';
type Intensity = 'Standard' | 'Strong';

interface TargetDef { key: string; name: string; icon: string; lufs: number; }
const TARGETS: TargetDef[] = [
  { key: 'Universal', name: 'Universal', icon: '∞', lufs: -14 },
  { key: 'Spotify',   name: 'Spotify',   icon: 'S', lufs: -14 },
  { key: 'YouTube',   name: 'YouTube',   icon: '▶', lufs: -14 },
  { key: 'Apple Music', name: 'Apple',   icon: '', lufs: -16 },
];

const STYLE_CARDS: Array<{ key: StyleChoice; name: string; caption: string; icon: string }> = [
  { key: 'kpop_loud', name: 'KPOP LOUD', caption: '체감 볼륨 최대, 보컬은 살림', icon: '★' },
  { key: 'balanced',  name: 'Balanced',  caption: '어디서나 무난한 표준',       icon: '◎' },
  { key: 'loud',      name: 'Loud',      caption: '강한 음압',                  icon: '▲' },
];

interface Props {
  /** Back to Import step. */
  onBack: () => void;
}

export default function ChooseView({ onBack }: Props) {
  const setPage = useAppStore((s) => s.setPage);
  const updateOptions = useAudioStore((s) => s.updateOptions);

  const [style, setStyle] = useState<StyleChoice | null>(null);
  const [intensity, setIntensity] = useState<Intensity>('Standard');
  const [target, setTarget] = useState<TargetDef>(TARGETS[0]!);

  const start = useCallback(() => {
    if (!style) return;

    // Base loudness: Balanced follows the platform target; loud styles are
    // loudness-driven by the style itself.
    let targetLufs: number;
    let targetTp: number;
    if (style === 'kpop_loud')      { targetLufs = -9;  targetTp = -0.8; }
    else if (style === 'loud')      { targetLufs = -10; targetTp = -1.0; }
    else                            { targetLufs = target.lufs; targetTp = -1.0; } // balanced

    const limiterStrength: LimiterStrength = intensity === 'Strong' ? 'high' : 'medium';

    // Strong = +1 LU louder, except KPOP Loud (limiter only).
    if (intensity === 'Strong' && style !== 'kpop_loud') targetLufs += 1;

    updateOptions({
      style: style as MasteringStyle,
      targetLufs,
      targetTp,
      limiterStrength,
      quickPreset: undefined,
    });
    setPage('mastering');
  }, [style, intensity, target, updateOptions, setPage]);

  return (
    <div className="h-full overflow-auto px-7 py-8 max-w-[680px] mx-auto w-full">
      <div className="flex items-center">
        <button type="button" onClick={onBack} className="text-[13px] text-zinc-500 font-semibold">← 파일 다시 선택</button>
        <span className="ml-auto text-[13px] text-zinc-600 font-semibold">1 / 3 · 스타일</span>
      </div>

      <h2 className="text-[25px] font-bold tracking-tight mt-[10px]">어떤 느낌으로 만들까요?</h2>
      <p className="text-[16px] text-zinc-400 mt-1">세 가지만 고르면 끝.</p>

      <div className="text-[12px] text-zinc-500 font-bold tracking-[.14em] uppercase mt-5 mb-[10px]">Style</div>
      <div className="grid grid-cols-2 gap-3">
        {STYLE_CARDS.map((c) => (
          <StyleCard
            key={c.key}
            name={c.name}
            caption={c.caption}
            icon={c.icon}
            styleKey={c.key}
            selected={style === c.key}
            onClick={() => setStyle(c.key)}
          />
        ))}
      </div>

      <div className="text-[12px] text-zinc-500 font-bold tracking-[.14em] uppercase mt-5 mb-[10px]">Intensity</div>
      <SegToggle<Intensity>
        options={[{ value: 'Standard', label: 'Standard' }, { value: 'Strong', label: 'Strong' }]}
        value={intensity}
        onChange={setIntensity}
      />

      <div className="text-[12px] text-zinc-500 font-bold tracking-[.14em] uppercase mt-5 mb-[10px]">Target</div>
      <div className="grid grid-cols-4 gap-[10px]">
        {TARGETS.map((t) => (
          <TargetCard
            key={t.key}
            name={t.name}
            icon={t.icon}
            lufsLabel={`−${Math.abs(t.lufs)}`}
            selected={target.key === t.key}
            onClick={() => setTarget(t)}
          />
        ))}
      </div>

      <div className="mt-6">
        <CtaButton accentStyle={style} disabled={!style} onClick={start}>
          {style ? '마스터링 시작' : '스타일을 선택하세요'}
        </CtaButton>
      </div>
    </div>
  );
}
