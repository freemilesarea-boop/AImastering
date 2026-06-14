// Guided flow — Home container (PROTOTYPE-PORT T5).
//
// Hosts the two front-of-flow sub-steps (Import → Choose) for the guided
// "three picks" experience.  Mastering + Result reuse the existing pages
// (set via setPage in ChooseView).  Mounted on the `home` route only when
// the guided-flow flag is ON (see App.tsx, T6).
import React, { useState } from 'react';
import { useAudioStore } from '../../stores/audioStore.js';
import ImportView from './ImportView.js';
import ChooseView from './ChooseView.js';
import HomePage from '../../pages/HomePage.js';

export default function GuidedHome() {
  // Preserve a selected file when returning from Mastering (cancel/back).
  const hasFile = useAudioStore((s) => s.selectedFile != null);
  const [step, setStep] = useState<'import' | 'choose' | 'batch'>(hasFile ? 'choose' : 'import');

  // Batch (legacy multi-file) is preserved as a secondary entry (T10).
  if (step === 'batch') {
    return (
      <div className="relative h-screen overflow-hidden">
        <button
          type="button"
          onClick={() => setStep('import')}
          className="absolute top-3 left-4 z-20 text-[13px] text-zinc-400 hover:text-zinc-100
                     bg-zinc-900/70 border border-zinc-700 rounded-lg px-3 py-1.5 no-drag"
        >
          ← 가이드 모드
        </button>
        <HomePage />
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-[#13131A] text-zinc-100">
      {step === 'import'
        ? <ImportView onPicked={() => setStep('choose')} onBatch={() => setStep('batch')} />
        : <ChooseView onBack={() => setStep('import')} />}
    </div>
  );
}
