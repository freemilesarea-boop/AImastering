import React, { useEffect } from 'react';
import { useAppStore } from './stores/appStore.js';
import { useLicenseStore } from './stores/licenseStore.js';
import LicenseModal from './components/LicenseModal.js';
import HomePage from './pages/HomePage.js';
import MasteringPage from './pages/MasteringPage.js';
import ResultPage from './pages/ResultPage.js';
import QCPage from './pages/QCPage.js';
import SettingsPage from './pages/SettingsPage.js';

export default function App() {
  const page = useAppStore((s) => s.currentPage);
  const load = useLicenseStore((s) => s.load);

  // Load license state once on startup
  useEffect(() => { void load(); }, [load]);

  const pages: Record<string, React.ReactNode> = {
    home:      <HomePage />,
    mastering: <MasteringPage />,
    result:    <ResultPage />,
    qc:        <QCPage />,
    settings:  <SettingsPage />,
  };

  return (
    <div className="h-screen flex overflow-hidden">
      {pages[page] ?? <HomePage />}
      {/* License modal is rendered at the root so it overlays any page */}
      <LicenseModal />
    </div>
  );
}
