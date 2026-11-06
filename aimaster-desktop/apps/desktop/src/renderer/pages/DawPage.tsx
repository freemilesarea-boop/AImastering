// DawPage — the Pro Tools-shaped workspace: one session, two windows.
//
// Edit and Mix are two views of the SAME session object, so a fader move in
// Mix is on the clip lane's automation the moment you switch back.  The page
// owns the chrome (transport, track creation, bounce/freeze); the windows own
// their own interaction.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { useDawStore } from '../stores/dawStore.js';
import { useWorkspaceStore } from '../stores/workspaceStore.js';
import EditWindow from '../components/daw/edit/EditWindow.js';
import MixWindow from '../components/daw/mix/MixWindow.js';
import KeyEditor from '../components/daw/midi/KeyEditor.js';
import InstrumentRack from '../components/daw/InstrumentRack.js';
import SmartControlPanel from '../components/daw/smart/SmartControlPanel.js';
import DeviceChainView from '../components/daw/chain/DeviceChainView.js';
import SessionViewGrid from '../components/daw/session/SessionViewGrid.js';
import SpectralEditor from '../components/daw/spectral/SpectralEditor.js';
import VocalEditor from '../components/daw/vocal/VocalEditor.js';
import VideoViewer from '../components/daw/video/VideoViewer.js';
import { useVideoStore } from '../stores/videoStore.js';
import { findRecoveries, loadRecovery, type RecoveryOffer } from '../daw/engine/autosave-driver.js';
import type { RecoveryInfo } from '../daw/model/autosave.js';
import { premium } from '../theme/premium.js';
import ReferencePanel from '../components/daw/reference/ReferencePanel.js';
import WarpEditor from '../components/daw/warp/WarpEditor.js';
import RestorePanel from '../components/daw/restore/RestorePanel.js';
import SeparatePanel from '../components/daw/separate/SeparatePanel.js';
import RecordStrip from '../components/daw/record/RecordStrip.js';
import StepSequencer from '../components/daw/steps/StepSequencer.js';
import IntelPanel from '../components/daw/intel/IntelPanel.js';
import PluginWindowLayer from '../components/daw/plugin/PluginWindowLayer.js';
import RegionLab from '../components/daw/region/RegionLab.js';

import { runCommand } from '../shortcuts/command-runner.js';
import { findShortcut, type CommandId } from '../shortcuts/definitions.js';
import { describeSpec, effectiveChords, type Overrides } from '../shortcuts/key-overrides.js';
import { detectPlatform, type Platform } from '../shortcuts/keys.js';
import { useShortcutStore } from '../stores/shortcutStore.js';
import { shouldAdoptQueue } from '../daw/model/import-audio.js';
import { describeImport, importIntoSession } from '../daw/edit/session-import.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import TemplatePanel from '../components/daw/template/TemplatePanel.js';
import PanelWindowLayer from '../components/daw/PanelWindowLayer.js';
import { usePanelWindowStore } from '../stores/panelWindowStore.js';
import { DAW_PANELS, type DawWindow } from '../daw/model/view-window.js';
import LayoutMenu from '../components/daw/LayoutMenu.js';
import { setSessionTempo } from '../daw/model/tempo-reanchor.js';
import { commandTitle } from '../shortcuts/command-title.js';

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.000';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/**
 * One panel, by name — the only place a window id becomes a component.
 *
 * Both the dock and the floating layer call this, so a panel torn off the tab
 * strip is the same component the tab shows and not a second implementation
 * of it.  Module scope rather than inside the component: it closes over
 * nothing, and rebuilding it every render would remount every floating panel
 * on every keystroke.
 */
function renderPanel(id: DawWindow): React.ReactElement {
  switch (id) {
    case 'edit':      return <EditWindow />;
    case 'mix':       return <MixWindow />;
    case 'midi':      return <KeyEditor />;
    case 'chain':     return <DeviceChainView />;
    case 'session':   return <SessionViewGrid />;
    case 'steps':     return <StepSequencer />;
    case 'warp':      return <WarpEditor />;
    case 'spectral':  return <SpectralEditor />;
    case 'vocal':     return <VocalEditor />;
    case 'stems':     return <SeparatePanel />;
    case 'restore':   return <RestorePanel />;
    case 'intel':     return <IntelPanel />;
    case 'reference': return <ReferencePanel />;
  }
}

/**
 * Non-fatal engine notices, on screen.
 *
 * `engineWarning` has been in the store, with "feedback loops, decode
 * failures" in its own comment, since it was written — and nothing set it and
 * nothing drew it.  A missing source was the case it was for: the track went
 * quiet, the waveform stayed blank, and the app said nothing at all.
 *
 * A bar rather than a toast, because this one has to survive being ignored:
 * a toast that faded while somebody was looking at the timeline would leave
 * them with the silence and no explanation for it.
 */
function EngineWarningBar() {
  const warning = useDawStore((s) => s.engineWarning);
  const setEngineWarning = useDawStore((s) => s.setEngineWarning);
  if (!warning) return null;
  return (
    <div
      className="flex items-center gap-2 px-3 py-1 border-b text-[11px]"
      style={{
        background: 'rgba(224,112,112,0.12)', borderColor: 'rgba(224,112,112,0.35)',
        color: '#f0b0b0',
      }}
      data-testid="engine-warning"
    >
      <span className="shrink-0">⚠</span>
      <span className="flex-1 truncate" title={warning}>{warning}</span>
      <button
        onClick={() => setEngineWarning(null)}
        className="shrink-0 px-1.5 h-5 rounded border border-zinc-700 bg-zinc-900 text-zinc-400"
      >닫기</button>
    </div>
  );
}

export default function DawPage() {
  // A tooltip asks the keymap rather than spelling a chord out, so it
  // follows a remap and shows the key this platform prints.
  const chordOverrides = useShortcutStore((s) => s.overrides);
  const chordPlatform = useMemo(() => detectPlatform(), []);
  const setPage      = useAppStore((s) => s.setPage);
  const notify       = useAppStore((s) => s.notify);
  const session      = useDawStore((s) => s.session);
  const apply        = useDawStore((s) => s.apply);
  const tool         = useWorkspaceStore((s) => s.tool);
  const setTool      = useWorkspaceStore((s) => s.setTool);
  const rackOpen     = useWorkspaceStore((s) => s.panels.vstEditor);
  const setPanel     = useWorkspaceStore((s) => s.setPanel);
  const windowMode   = useDawStore((s) => s.window);
  const floatPanel   = usePanelWindowStore((s) => s.float);
  // Ids only: subscribing to the window objects would re-render the whole
  // page on every drag of a floating panel.
  const floatingIds  = usePanelWindowStore((s) => s.windows.map((w) => w.id));
  const setWindow    = useDawStore((s) => s.setWindow);
  const isPlaying    = useDawStore((s) => s.isPlaying);
  const togglePlay   = useDawStore((s) => s.togglePlay);
  const seek         = useDawStore((s) => s.seek);
  const playheadSec  = useDawStore((s) => s.playheadSec);
  const metronomeOn  = useDawStore((s) => s.metronomeOn);
  const loopEnabled  = useDawStore((s) => s.loopEnabled);
  const toggleLoop   = useDawStore((s) => s.toggleLoop);
  // Both of these live in the store rather than here because the actions that
  // drive them are commands now, and a command cannot reach a page's
  // useState — see the note on `busy` in dawStore.
  const busy = useDawStore((s) => s.busy);
  const setBusy = useDawStore((s) => s.setBusy);

  // Files the user loaded on the home screen.  The DAW used to ignore them
  // entirely, which meant opening it always showed an empty session — you
  // could not start a project with the music you had just imported.
  const queue = useAudioStore((s) => s.queue);
  const importedOnce = useRef(false);

  const invoke = useCallback(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const api = window.electronAPI;
    if (!api) throw new Error('electronAPI를 사용할 수 없습니다');
    return api.invoke(channel as Parameters<typeof api.invoke>[0], ...args);
  }, []);

  /** Pull the home screen's files in as audio tracks. */
  const importQueue = useCallback(async (silent = false) => {
    const paths = useAudioStore.getState().queue.map((q) => q.filePath).filter(Boolean);
    if (paths.length === 0) {
      if (!silent) notify('홈 화면에 불러온 곡이 없습니다', 'warning');
      return;
    }
    setBusy(`홈에서 불러온 곡을 가져오는 중… 0/${paths.length}`);
    try {
      // Decoding is sequential, so the count is real progress, not a spinner.
      const report = await importIntoSession(paths, [], 0,
        (done, total) => setBusy(`홈에서 불러온 곡을 가져오는 중… ${done}/${total}`));
      // These rows are now this session's source material.  Without this the
      // mix comes back as a SECOND row beside the file it was made from, with
      // the same name — and nobody can tell which one to release.
      const failed = new Set(report.failed);
      useAudioStore.getState().adoptQueueIntoSession(
        useDawStore.getState().session.id, paths.filter((p) => !failed.has(p)));
      notify(describeImport(report), report.failed.length ? 'warning' : 'success');
    } catch (err) {
      notify(`가져오기 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [notify, setBusy]);

  /**
   * On the first visit, an empty session adopts whatever is on the home
   * screen.  Nothing can be lost — the session has no audio yet — and it is
   * the only behaviour that makes "load songs, open the DAW" work the way
   * anyone would expect.
   */
  useEffect(() => {
    if (importedOnce.current) return;
    if (!shouldAdoptQueue(session, queue.length)) return;
    importedOnce.current = true;
    void importQueue(true);
    // `session.tracks` and not `session`: this runs at most once, guarded by
    // `importedOnce`, and re-running it on every unrelated session change
    // would only re-test a flag that is already set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length, session.tracks, importQueue]);

  const handleImportAudio = useCallback(async () => {
    const paths = await invoke('file:open-dialog-multi') as string[] | null;
    if (!paths?.length) return;
    setBusy(`오디오 불러오는 중… 0/${paths.length}`);
    try {
      const report = await importIntoSession(paths, [], playheadSec,
        (done, total) => setBusy(`오디오 불러오는 중… ${done}/${total}`));
      notify(describeImport(report), report.failed.length ? 'warning' : 'success');
    } catch (err) {
      notify(`가져오기 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  }, [invoke, notify, playheadSec, setBusy]);

  /**
   * Adding an instrument means CHOOSING one.
   *
   * This button used to make a `polysynth` called `Synth N` without asking,
   * which is how four working instruments ended up unreachable from the only
   * place anyone looks for them.  It opens the rack instead — the same window
   * F11 opens, so there is one door rather than two that behave differently.
   */
  const handleAddInstrument = useCallback(() => {
    setPanel('vstEditor', true);
  }, [setPanel]);

  /** Import a .mid — one instrument track per source track, MPE preserved. */
  /** Wrap the selected tracks (or the focused one) in a summing stack. */
  /**
   * Bring in a picture editor's AAF.
   *
   * The media it names lives on the machine that wrote it, so the import
   * reports what came across and leaves the audio to be relinked — a session
   * of clips at the right times with the wrong paths is still the day's work
   * saved, and pretending the files are here would not be.
   */
  /**
   * Render the mix and hand it to the mastering queue, then go there.
   *
   * The navigation is part of the action, not a courtesy.  Sending a mix to a
   * list on another screen and staying put leaves the person to wonder whether
   * it worked; the whole point of the button is that mixing and mastering stop
   * being two errands.
   */
  /**
   * Run a toolbar button's command by id.
   *
   * `runCommand` answers false when the command map has not been published —
   * the keyboard layer mounts with this page, so that window is brief, but a
   * button that silently does nothing is the failure this app keeps refusing.
   * Say it instead.
   */
  const templatesOpen = useDawStore((s) => s.templatesOpen);
  const setTemplatesOpen = useDawStore((s) => s.setTemplatesOpen);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        subtitle={`DAW · ${windowMode.toUpperCase()}`}
        actions={
          <button onClick={() => setPage('home')}
            className="hit-target text-xs text-zinc-600 hover:text-zinc-400 transition-colors">← 홈</button>
        }
      />

      <EngineWarningBar />

      {/* Transport / session chrome */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800 bg-[#15151d] flex-nowrap overflow-x-auto [&>*]:shrink-0">
        <div className="flex rounded-md overflow-hidden border border-zinc-700 mr-1">
          {/* One list, from view-window.ts.  The labels used to be spelled out
              here in a thirteen-arm ternary and the bodies repeated the same
              thirteen names further down — two parallel lists that drift. */}
          {DAW_PANELS.map(({ id: w, label }) => (
            <button key={w}
              onClick={() => setWindow(w)}
              onDoubleClick={() => floatPanel(w)}
              title={`${label} — 더블클릭하면 따로 띄웁니다`}
              className={`px-3 py-1 text-[11px] font-medium transition-colors relative ${
                windowMode === w ? 'bg-indigo-600/30 text-indigo-300' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
            >
              {label}
              {/* A dot on a tab whose panel is also floating, so the strip says
                  where the second copy went rather than leaving it a surprise. */}
              {floatingIds.includes(w) && (
                <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400/80" />
              )}
            </button>
          ))}
        </div>

        {/* Saved rooms.  Beside the tab strip because that is what it changes
            wholesale — the docked window, the panels and the floats at once. */}
        <LayoutMenu />

        <button onClick={() => { dawRuntime.ensure(session.sampleRate); seek(0); }}
          title={commandTitle('transport.returnToZero', chordOverrides, chordPlatform, '처음으로')}
          className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 text-[11px]">⏮</button>
        <button onClick={() => { dawRuntime.ensure(session.sampleRate); togglePlay(); }}
          title={commandTitle('transport.playPause', chordOverrides, chordPlatform, '재생 / 정지')}
          className={`h-7 px-3 rounded border text-[11px] ${isPlaying
            ? 'bg-emerald-600/25 border-emerald-500/50 text-emerald-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-300'}`}>{isPlaying ? '❚❚' : '▶'}</button>
        <button onClick={() => useVideoStore.getState().toggle()} title={commandTitle('daw.togglePicture', chordOverrides, chordPlatform, '픽처 창')}
          className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 text-[11px]">PIC</button>
        <button onClick={() => useDawStore.getState().toggleMetronome()}
          title={commandTitle('transport.metronome', chordOverrides, chordPlatform,
                    '메트로놈 · 템포 맵을 따라갑니다')}
          className={`h-7 px-2 rounded border text-[11px] ${metronomeOn
            ? 'bg-amber-600/25 border-amber-500/50 text-amber-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-400'}`}>♩</button>
        <button onClick={toggleLoop} title={commandTitle('transport.toggleLoop', chordOverrides, chordPlatform, '루프')}
          className={`h-7 px-2 rounded border text-[11px] ${loopEnabled
            ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-400'}`}>LOOP</button>

        <span className="ml-2 text-[12px] font-mono text-zinc-200 tabular-nums">{fmt(playheadSec)}</span>

        <label className="ml-2 flex items-center gap-1 text-[10px] text-zinc-500" title="세션 템포 — 워프된 클립이 따라옵니다">
          <input
            type="number" min={20} max={300} step={0.5} value={session.tempoBpm}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (!Number.isFinite(value) || value <= 0) return;
              const { session: next, unwarpedClipIds } = setSessionTempo(
                useDawStore.getState().session, value);
              apply(() => next);
              if (unwarpedClipIds.length > 0) {
                notify(`${next.tempoBpm} BPM — 워프가 꺼진 클립 ${unwarpedClipIds.length}개는 길이가 그대로입니다`, 'warning');
              }
            }}
            className="w-16 h-7 px-1.5 rounded bg-zinc-900 border border-zinc-700
                       text-zinc-200 text-[11px] font-mono tabular-nums"
          />
          BPM
        </label>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        {/* Scissors.  A toggle rather than a one-shot, because cutting a piece
            out takes two clicks and switching tools between them is the kind
            of friction that makes a feature go unused. */}
        <ToolbarButton
          onClick={() => setTool(tool === 'split' ? 'select' : 'split')}
          accent={tool === 'split'}
          // Not `cmd`: the key SELECTS the split tool and this button TOGGLES
          // it, so naming the chord here would promise something else.
          title="클립을 자르는 도구를 켜고 끕니다 — 도구는 숫자키로도 전환됩니다"
        >✂ 가위</ToolbarButton>

        <ToolbarButton onClick={handleImportAudio}
                       title="오디오 파일을 플레이헤드 위치에 트랙으로 추가">오디오 추가</ToolbarButton>
        {queue.length > 0 && (
          <ToolbarButton onClick={() => void importQueue()}
                         title="홈 화면 대기열에 있는 곡을 이 세션으로 가져옵니다">
            홈 트랙 가져오기 ({queue.length})
          </ToolbarButton>
        )}
        <ToolbarButton cmd="daw.newTrack">+ 트랙</ToolbarButton>
        <ToolbarButton onClick={handleAddInstrument}
                       title="악기 트랙을 추가하고 랙을 엽니다">+ 인스트루먼트</ToolbarButton>
        <ToolbarButton cmd="daw.importMidi">MIDI 가져오기</ToolbarButton>
        <ToolbarButton cmd="daw.addAux">+ Aux</ToolbarButton>
        <ToolbarButton cmd="daw.addVca">+ VCA</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton cmd="daw.smartControls">스마트 컨트롤</ToolbarButton>
        <ToolbarButton cmd="daw.createStack">스택 만들기</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton cmd="daw.freeze">프리즈</ToolbarButton>
        <ToolbarButton cmd="daw.commit">커밋</ToolbarButton>
        <ToolbarButton cmd="daw.bounce">바운스</ToolbarButton>
        {/* The seam this app is actually for: mix here, master there, one
            press.  Highlighted because it is the finish line, and placed next
            to 바운스 because that is where someone goes looking for "I am
            done" — the difference being that this one does not ask for a
            folder or count as an export. */}
        <ToolbarButton cmd="daw.sendToMastering" accent>
          마스터링으로 →
        </ToolbarButton>
        <ToolbarButton cmd="daw.exportStems">스템</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton cmd="daw.templates">템플릿</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton cmd="file.save">세션 저장</ToolbarButton>
        <ToolbarButton cmd="file.openSession">세션 열기</ToolbarButton>
        <ToolbarButton cmd="daw.importSession">세션 가져오기</ToolbarButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <ToolbarButton cmd="daw.importAaf">AAF 가져오기</ToolbarButton>
        <ToolbarButton cmd="daw.exportAaf">AAF 내보내기</ToolbarButton>

        <div className="flex-1" />
        {busy && <span className="text-[11px] text-amber-400">{busy}</span>}
      </div>

      {/* Floating plugin windows live above every view, so switching from Edit
          to Mix does not close the compressor you were setting. */}
      <PluginWindowLayer />
      <RegionLab />

      <RecordStrip />

      <SmartControlPanel />

      {renderPanel(windowMode)}

      {/* Torn-off panels, over everything the workspace draws.  They render
          the SAME component the dock does — one renderer, so a floating MIX
          and a docked MIX cannot come to show different things. */}
      <PanelWindowLayer render={renderPanel} />

      {templatesOpen && <TemplatePanel onClose={() => setTemplatesOpen(false)} />}

      {/* F11 — the instrument rack.  It reuses the `vstEditor` panel flag that
          already existed under that name, so the key, the label and the panel
          finally mean the same thing. */}
      {rackOpen && <InstrumentRack onClose={() => setPanel('vstEditor', false)} />}

      {/* Floats over every window — scoring means watching the picture WHILE
          arranging, not instead of it. */}
      <VideoViewer />
      <RecoveryPrompt />
    </div>
  );
}

/**
 * Run a command by id from a doorway that is not the keyboard.
 *
 * `runCommand` answers false when the command map has not been published yet —
 * the keyboard layer mounts with this page, so that window is brief, but a
 * button that silently does nothing is the failure this app keeps refusing.
 *
 * Module level, not a hook, so `ToolbarButton` can take a command id and be
 * the thing that runs it: the id was being written twice, once to run and
 * once to label.
 */
function runOrSay(id: CommandId): void {
  if (!runCommand(id)) {
    useAppStore.getState().notify('아직 준비되지 않았습니다 — 잠시 후 다시 눌러주세요', 'warning');
  }
}

/**
 * What to put in a button's tooltip: the command's own name and its key.
 *
 * Read through `effectiveChords`, so a student who remapped 프리즈 sees THEIR
 * key here — the same function the right-click menus use, which have shown
 * their chords since they were built.  The toolbar was the one surface that
 * never said a word about the keyboard, and it is the surface a beginner
 * actually uses.
 */
function buttonHint(id: CommandId, overrides: Overrides, platform: Platform): string | undefined {
  const def = findShortcut(id);
  if (!def) return undefined;
  const first = effectiveChords(def, overrides)[0];
  return first === undefined ? def.label : `${def.label} — ${describeSpec(first, platform)}`;
}

function ToolbarButton(
  { onClick, children, accent, cmd, title }:
  {
    onClick?: () => void;
    children: React.ReactNode;
    accent?: boolean;
    /** The command this button is, when it is one — it then runs and labels itself. */
    cmd?: CommandId;
    /** For a button that is not a command: say what it does anyway. */
    title?: string;
  },
) {
  const overrides = useShortcutStore((s) => s.overrides);
  const platform = useMemo(() => detectPlatform(), []);
  const hint = cmd === undefined ? title : buttonHint(cmd, overrides, platform);
  const press = cmd === undefined ? onClick : () => runOrSay(cmd);
  // One button in this row is the finish line and the rest are tools.  The
  // accent is the app's own gold rather than a new colour, so the row still
  // reads as one row.
  if (accent === true) {
    return (
      <button
        onClick={press}
        title={hint}
        className="h-7 px-2.5 rounded text-[11px] transition-colors"
        style={{
          background: 'rgba(198,167,104,0.16)',
          color: premium.accent.light,
          border: `1px solid ${premium.accent.deep}`,
        }}
      >{children}</button>
    );
  }
  return (
    <button
      onClick={press}
      title={hint}
      className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 text-zinc-400
                 text-[11px] hover:text-zinc-200 hover:border-zinc-600 transition-colors"
    >{children}</button>
  );
}

/**
 * The crash-recovery offer.
 *
 * Shown ONCE, at startup, and only when there is something worth offering —
 * a full-width banner every time the app opens would train people to dismiss
 * it, which is the one thing it must not do.
 *
 * It never opens anything by itself.  Restoring replaces the open session, so
 * it is a decision, not a convenience.
 */
function RecoveryPrompt() {
  const [offers, setOffers] = useState<RecoveryOffer[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const notify = useAppStore((s) => s.notify);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    void findRecoveries((c, ...a) => api.invoke(c as never, ...a)).then(setOffers);
  }, []);

  if (dismissed || offers.length === 0) return null;
  const offer = offers[0]!;

  /**
   * Restore one generation.
   *
   * On a failure the banner is kept open when there is an older copy to try,
   * and only then.  The previous shape dismissed on every outcome, so a
   * recovery file that would not parse spent the user's one chance and left
   * the copy the main process had deliberately kept unreachable.
   */
  const restore = async (info: RecoveryInfo, fallbackLeft: boolean): Promise<void> => {
    const api = window.electronAPI;
    if (!api) return;
    const result = await loadRecovery((c, ...a) => api.invoke(c as never, ...a), info);
    if ('error' in result) {
      if (!fallbackLeft) setDismissed(true);
      notify(
        fallbackLeft
          ? `복구하지 못했습니다: ${result.error} — 그 전 자동 저장을 시도해 보세요`
          : `복구하지 못했습니다: ${result.error}`,
        'error',
      );
      return;
    }
    setDismissed(true);
    useDawStore.getState().loadSession(result.session);
    notify(`${info.sessionName} 을 복구했습니다`, 'success');
  };

  return (
    <div className="fixed z-50 rounded shadow-2xl"
         style={{
           right: 20, bottom: 20, width: 320, padding: '14px 16px',
           background: premium.surface.frame,
           border: `1px solid ${premium.accent.deep}`,
         }}>
      <div style={{ fontSize: 11, letterSpacing: '0.12em', color: premium.accent.base }}>
        복구할 세션이 있습니다
      </div>
      <div style={{ fontSize: 12.5, color: premium.text.primary, margin: '6px 0 2px' }}>
        {offer.label}
      </div>
      <p style={{ fontSize: 11, color: premium.text.muted, margin: '0 0 10px' }}>
        {/* Not "the app crashed": nothing here knows that.  What is known
            is that this project was edited and not saved by hand afterwards
            — a clean save deletes the file this is offering. */}
        저장하지 않은 작업이 남아 있습니다. 복구하면 지금 열려 있는
        세션을 대체합니다.
      </p>
      <div className="flex gap-1.5">
        <button onClick={() => { void restore(offer.info, offer.previous !== undefined); }}
          className="h-6 px-2.5 rounded text-[11px]"
          style={{ background: 'rgba(198,167,104,0.16)', color: premium.accent.light,
                   border: `1px solid ${premium.accent.deep}` }}>복구</button>
        <button onClick={() => setDismissed(true)}
          className="h-6 px-2.5 rounded text-[11px]"
          style={{ background: 'transparent', color: premium.text.muted,
                   border: `1px solid ${premium.surface.hairline}` }}>무시</button>
      </div>
      {/* The copy from before the newest one, when the main process still has
          it.  Shown only then, and under the two buttons rather than beside
          them: it is the way out of a broken session, not an equal choice. */}
      {offer.previous && (
        <button onClick={() => { void restore(offer.previous!.info, false); }}
          style={{ marginTop: 9, background: 'transparent', padding: 0,
                   fontSize: 11, color: premium.text.muted,
                   textDecoration: 'underline', textUnderlineOffset: 3 }}>
          {/* `으로`, not `로`: the label always ends in `전`, which closes on a
              consonant.  The running app read "방금 전 로 복구". */}
          {offer.previous.label}으로 복구
        </button>
      )}
    </div>
  );
}
