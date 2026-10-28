import { useState, useEffect } from 'react';
import { auth } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { LoginForm } from './components/LoginForm';
import { Toaster } from 'sonner';
import { AnimatePresence } from 'motion/react';

// Hooks & Layouts
import { useDashboardData } from './hooks/useDashboardData';
import { DashboardLayout } from './layouts/DashboardLayout';
import { ACCENTS, getAccent } from './lib/accent';

// View Pages
import { DashboardHome } from './pages/DashboardHome';
import { MonthlyReportView } from './pages/MonthlyReportView';
import { SettingsView } from './pages/SettingsView';
import { FichierExploitationEauView } from './pages/FichierExploitationEauView';
import { StatisticsView } from './pages/StatisticsView';
import { PointageView } from './pages/PointageView';
import { RefectionView } from './pages/RefectionView';
import { EnveloppeFinanciereView } from './pages/EnveloppeFinanciereView';

// استيراد مكون استيراد الإكسل الجديد
import SRMExcelImporter from './components/SRMExcelImporter';

const AccentPicker = ({ accent, onAccentChange }) => (
  <span className="inline-flex items-center gap-1.5" role="group" aria-label="Couleur du thème">
    {ACCENTS.map((a) => (
      <button
        key={a.id}
        type="button"
        title={a.name}
        aria-label={`Thème ${a.name}`}
        aria-pressed={accent === a.id}
        onClick={() => onAccentChange(a.id)}
        className={`w-5 h-5 rounded-full border-2 transition ${accent === a.id ? 'border-slate-900 scale-110' : 'border-white/60 hover:scale-110'}`}
        style={{ backgroundColor: a.light }}
      />
    ))}
  </span>
);

const AuthenticatedApp = ({ user, activeView, setActiveView, theme, onToggleTheme, accent, onAccentChange }) => {
  const dashboardData = useDashboardData(user);

  return (
    <DashboardLayout activeView={activeView} setActiveView={setActiveView} theme={theme} onToggleTheme={onToggleTheme} accent={accent} onAccentChange={onAccentChange}>
      <AnimatePresence mode="wait">
        {activeView === 'home' && (
          <DashboardHome
            stats={dashboardData.stats}
            dataList={dashboardData.dataList}
            chartData={dashboardData.chartData}
            theme={theme}
            accent={accent}
          />
        )}
        {activeView === 'pointage' && (
          <PointageView user={user} />
        )}
        {activeView === 'rapport' && (
          <MonthlyReportView 
            {...dashboardData} 
          />
        )}
        {activeView === 'refection' && (
          <RefectionView />
        )}
        {activeView === 'statistics' && (
          <StatisticsView dataList={dashboardData.dataList} theme={theme} accent={accent} />
        )}
        {activeView === 'fichier' && (
          <FichierExploitationEauView user={user} {...dashboardData} />
        )}
        
        {activeView === 'srm-excel' && (
          <div className="p-4 md:p-6 max-w-4xl mx-auto">
            <SRMExcelImporter />
          </div>
        )}

        {/* Enveloppe block: outside the srm-excel block */}
        {activeView === 'enveloppe' && (
          <EnveloppeFinanciereView />
        )}

        {activeView === 'settings' && (
          <SettingsView 
            typeOptions={dashboardData.typeOptions}
            natureOptions={dashboardData.natureOptions}
            handleAddOption={dashboardData.handleAddOption}
            handleRemoveOption={dashboardData.handleRemoveOption}
          />
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
};

function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeView, setActiveView] = useState('home');
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('hydraucan-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  const [accent, setAccent] = useState(() => {
    try { return getAccent(localStorage.getItem('hydraucan-accent')).id; } catch { return 'navy'; }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('theme-dark', theme === 'dark');
    try { localStorage.setItem('hydraucan-theme', theme); } catch {}
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try { localStorage.setItem('hydraucan-accent', accent); } catch {}
  }, [accent]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  if (authLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${theme === 'dark' ? 'bg-[#0F172A]' : 'bg-[#EEF2F7]'}`}>
        <span className="w-8 h-8 border-4 border-[#1A2B56]/30 border-t-[#1A2B56] rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'bg-[#0F172A]' : 'bg-[#EEF2F7]'}`}>
        <header className="bg-[#16294D] text-white">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
            <img src="/logo-hydracane.png" alt="HYDRAUCAN" className="h-10 w-auto object-contain brightness-200" />
            <div className="flex items-center gap-3">
              <AccentPicker accent={accent} onAccentChange={setAccent} />
              <button onClick={toggleTheme} aria-label="Changer de thème" className="inline-flex items-center gap-1.5 rounded-full bg-white/10 border border-white/20 px-3 py-1 text-[11px] font-bold hover:bg-white/20 transition">
                {theme === 'dark' ? 'Clair' : 'Sombre'}
              </button>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 border border-white/20 px-3 py-1 text-[11px] font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-300" /> Espace employés
              </span>
            </div>
          </div>
        </header>
        <main className="flex-1 flex items-center justify-center px-4 py-10 sm:py-14">
          <Toaster position="top-center" richColors />
          <LoginForm theme={theme} />
        </main>
        <footer className="pb-6 text-center text-xs text-slate-500">
          Usage interne uniquement · Réservé aux employés Hydraucan
        </footer>
      </div>
    );
  }

  return (
    <>
      <Toaster position="top-right" richColors />
      <AuthenticatedApp user={user} activeView={activeView} setActiveView={setActiveView} theme={theme} onToggleTheme={toggleTheme} accent={accent} onAccentChange={setAccent} />
    </>
  );
}

export default App;