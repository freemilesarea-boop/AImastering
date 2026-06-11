/**
 * MasteringModeSelector — three large preset buttons.
 *
 *   <MasteringModeSelector value={mode} onChange={setMode} />
 *
 * Each button shows the mode label, its one-line description, and the
 * target LUFS.  The selected mode glows emerald with a thicker border;
 * the others sit dim and clickable.  Optional `disabled` flag locks
 * the row (e.g. while processing is in progress).
 */
import React from 'react';
import { MasteringMode, MODE_CONFIGS } from '../audio/masteringModes.js';

interface Props {
  value:     MasteringMode;
  onChange:  (m: MasteringMode) => void;
  disabled?: boolean;
  className?: string;
}

const ORDER: MasteringMode[] = ['CLEAN', 'BALANCED', 'LOUD'];

export function MasteringModeSelector(props: Props) {
  const { value, onChange, disabled = false, className } = props;

  return (
    <div className={`grid grid-cols-3 gap-3 ${className ?? ''}`}>
      {ORDER.map((mode) => {
        const cfg      = MODE_CONFIGS[mode];
        const selected = value === mode;
        const baseClass =
          'group relative flex h-28 flex-col items-center justify-center rounded-xl border-2 '
          + 'px-4 transition-all select-none';
        const stateClass = selected
          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-100 '
            + 'shadow-[0_0_24px_rgba(16,185,129,0.25)]'
          : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 '
            + 'hover:border-zinc-500 hover:text-zinc-200';
        const disabledClass = disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer';

        return (
          <button
            key={mode}
            type="button"
            onClick={() => !disabled && onChange(mode)}
            disabled={disabled}
            className={`${baseClass} ${stateClass} ${disabledClass}`}
          >
            <span className={`text-xl font-bold tracking-[0.2em] ${selected ? 'text-emerald-200' : ''}`}>
              {mode}
            </span>
            <span className="mt-1.5 text-[11px] text-center leading-snug">
              {cfg.description}
            </span>
            <span className={`mt-1 text-[11px] tabular-nums ${selected ? 'text-emerald-300/80' : 'text-zinc-300'}`}>
              target {cfg.targetLufs} LUFS
            </span>
            {selected && (
              <span className="absolute top-2 right-3 text-[11px] tracking-widest text-emerald-300/70">
                ◉ ACTIVE
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default MasteringModeSelector;
