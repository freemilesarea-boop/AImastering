import React from 'react';
import { useAppStore } from './stores/appStore.js';
import HomePage from './pages/HomePage.js';
import MasteringPage from './pages/MasteringPage.js';
import ResultPage from './pages/ResultPage.js';
import QCPage from './pages/QCPage.js';
import SettingsPage from './pages/SettingsPage.js';

export default function App() {
  const page = useAppStore((s) => s.currentPage);

  const pages: Record<string, React.ReactNode> = {
    home:     <HomePage />,
    mastering:<MasteringPage />,
    result:   <ResultPage />,
    qc:       <QCPage />,
    settings: <SettingsPage />,
  };

  return (
    <div className="h-screen flex overflow-hidden">
      {pages[page] ?? <HomePage />}
    </div>
  );
}
