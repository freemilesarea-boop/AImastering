// ModulePresetBar — one-click style presets that set all 5 Phase-2 modules.
//
// Each button writes the preset's multiband / imager / saturation / transient
// / dynamic-EQ configs into the store in one batch (via applyModulePreset).
// The individual module panels below stay fully editable afterwards.

import React from 'react';
import { useAudioStore } from '../stores/audioStore.js';
import { MODULE_PRESETS } from '../audio/module-presets.js';

export default function ModulePresetBar(): React.ReactElement {
  const apply = useAudioStore((s) => s.applyModulePreset);

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-zinc-600 uppercase tracking-wider">모듈 프리셋 (원클릭)</p>
      <div className="grid grid-cols-3 gap-2">
        {MODULE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            onClick={() => apply(p.build())}
            className="no-drag py-1.5 px-2 rounded-lg text-[11px] font-medium text-left
                       bg-zinc-800/60 border border-zinc-700 text-zinc-300
                       hover:border-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <div>{p.name}</div>
            <div className="text-[9px] text-zinc-500 mt-0.5 leading-tight">{p.hint}</div>
          </button>
        ))}
      </div>
      <p className="text-[10px] text-zinc-600">프리셋 적용 후 아래 모듈에서 세부 조정 가능. Export에 적용됩니다.</p>
    </div>
  );
}
