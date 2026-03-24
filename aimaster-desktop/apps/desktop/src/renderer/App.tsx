import React, { useEffect } from 'react';
import { useAppStore } from './stores/appStore.js';
import { useLicenseStore } from './stores/licenseStore.js';
import LicenseModal from './components/LicenseModal.js';
import HomePage     from './pages/HomePage.js';
import AnalysisPage from './pages/AnalysisPage.js';
import MasteringPage from './pages/MasteringPage.js';
import ResultPage   from './pages/ResultPage.js';
import QCPage       from './pages/QCPage.js';
import SettingsPage from './pages/SettingsPage.js';
import { useAppStore as useAppStoreNotification } from './stores/appStore.js';

// ── Toast notification ────────────────────────────────────────────────────────

function Toast() {
  const notif = useAppStoreNotification((s) => s.notification);
  if (!notif) return null;

  const colors: Record<string, string> = {
    info:    'bg-zinc-800  border-zinc-700   text-zinc-200',
    success: 'bg-zinc-800  border-emerald-700/50 text-emerald-300',
    warning: 'bg-zinc-800  border-amber-700/50   text-amber-300',
    error:   'bg-zinc-800  border-red-700/50     text-red-300',
  };

  return (
    <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50
                     px-4 py-2.5 rounded-xl border shadow-xl
                     text-sm animate-in-fast whitespace-nowrap
                     ${colors[notif.type] ?? colors.info}`}>
      {notif.message}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const page = useAppStore((s) => s.currentPage);
  const load = useLicenseStore((s) => s.load);

  // Load license state once on startup
  useEffect(() => { void load(); }, [load]);

  const pages: Record<string, React.ReactNode> = {
    home:      <HomePage />,
    analysis:  <AnalysisPage />,
    mastering: <MasteringPage />,
    result:    <ResultPage />,
    qc:        <QCPage />,
    settings:  <SettingsPage />,
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {pages[page] ?? <HomePage />}

      {/* License modal — overlays any page */}
      <LicenseModal />

      {/* Toast notifications */}
      <Toast />
    </div>
  );
}
