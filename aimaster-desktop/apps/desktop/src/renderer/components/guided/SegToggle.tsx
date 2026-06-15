// Guided flow — segmented toggle (Intensity) (PROTOTYPE-PORT T2).
import React from 'react';

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Big segmented control — replaces sliders for a discrete choice. */
export default function SegToggle<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="flex gap-[5px] p-[5px] rounded-2xl border border-zinc-700 bg-[#15151D]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex-1 py-[14px] rounded-[10px] text-[16px] font-semibold text-center transition-all
                        ${on ? 'bg-[#20202A] text-zinc-100 shadow-[0_2px_8px_rgba(0,0,0,.3)]' : 'text-zinc-400'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
