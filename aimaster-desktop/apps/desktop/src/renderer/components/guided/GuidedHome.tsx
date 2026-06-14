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

export default function GuidedHome() {
  // Preserve a selected file when returning from Mastering (cancel/back).
  const hasFile = useAudioStore((s) => s.selectedFile != null);
  const [step, setStep] = useState<'import' | 'choose'>(hasFile ? 'choose' : 'import');

  return (
    <div className="h-screen overflow-hidden bg-[#13131A] text-zinc-100">
      {step === 'import'
        ? <ImportView onPicked={() => setStep('choose')} />
        : <ChooseView onBack={() => setStep('import')} />}
    </div>
  );
}
