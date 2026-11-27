import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { auth } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { LoginForm } from './components/LoginForm';
import { Toaster } from 'sonner';
import { AnimatePresence, motion as Motion, useReducedMotion } from 'motion/react';

// Hooks & Layouts
import { useDashboardData } from './hooks/useDashboardData';
import { DashboardLayout } from './layouts/DashboardLayout';
import { ACCENTS, getAccent } from './lib/accent';

// View Pages — lazy-loaded (Batch 2): each view is its own chunk, so
// the first load only fetches the shell + the home view instead of
// one ~2.5 MB bundle with all 9 views, xlsx, jspdf and Leaflet.
const DashboardHome = lazy(() => import('./pages/DashboardHome').then((m) => ({ default: m.DashboardHome })));
const MonthlyReportView = lazy(() => import('./pages/MonthlyReportView').then((m) => ({ default: m.MonthlyReportView })));
const SettingsView = lazy(() => import('./pages/SettingsView').then((m) => ({ default: m.SettingsView })));
const FichierExploitationEauView = lazy(() => import('./pages/FichierExploitationEauView').then((m) => ({ default: m.FichierExploitationEauView })));
const StatisticsView = lazy(() => import('./pages/StatisticsView').then((m) => ({ default: m.StatisticsView })));
const PointageView = lazy(() => import('./pages/PointageView').then((m) => ({ default: m.PointageView })));
const RefectionView = lazy(() => import('./pages/RefectionView').then((m) => ({ default: m.RefectionView })));
const EnveloppeFinanciereView = lazy(() => import('./pages/EnveloppeFinanciereView').then((m) => ({ default: m.EnveloppeFinanciereView })));
const SRMExcelImporter = lazy(() => import('./components/SRMExcelImporter'));

// Fallback while a view chunk loads — same skeleton language as the
// auth loader above (pulsing blocks, no invented content).
const ViewFallback = () => (
  <div className="p-4 md:p-6 space-y-4" aria-label="Chargement de la page">
    <div className="h-8 w-56 rounded-lg bg-slate-300/60 animate-pulse" />
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="h-24 rounded-xl bg-slate-200/70 animate-pulse" />
      <div className="h-24 rounded-xl bg-slate-200/70 animate-pulse" />
      <div className="h-24 rounded-xl bg-slate-200/70 animate-pulse" />
    </div>
    <div className="h-64 rounded-xl bg-slate-200/70 animate-pulse" />
  </div>
);

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

// Theme exemption, updated 2026-10-28: Réfection's exemption was
// removed at Michael's request, so Réfection now follows the
// chosen accent and light/dark mode like every other view.
// Enveloppe financière stays exempt (light + navy, "Thème
// d'origine" badge) — only its exemption remains.
const EXEMPT_VIEWS = ['enveloppe'];

// Transitions Batch 1 (copy only): page side-by-side, in the
// transitions.dev "page side-by-side" style — rebuilt locally with
// motion, which the app already uses, not copied from the site.
// Previously the views switched with no transition (AnimatePresence
// was present but its children had no keys, so exits never ran).
// Each view is now a keyed motion wrapper: entering from the right
// when moving forward through the view order and from the left when
// moving back, with a short blur fade, 0.35s. No view, data or route
// is changed; Réfection and Enveloppe views themselves are untouched.
const VIEW_ORDER = ['home', 'pointage', 'rapport', 'refection', 'statistics', 'fichier', 'srm-excel', 'enveloppe', 'settings'];
const PageTransition = ({ viewKey, direction, children }) => {
  const shouldReduceMotion = useReducedMotion();
  // Phone & UX phase (2026-11-26): smaller slide distance on narrow
  // screens so the transition doesn't feel like a long swipe.
  const x = typeof window !== 'undefined' && window.innerWidth < 640 ? 12 : 28;
  if (shouldReduceMotion) {
    return <div className="min-w-0">{children}</div>;
  }
  return (
    <Motion.div
      key={viewKey}
      initial={{ opacity: 0, x: direction * x, filter: 'blur(4px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: direction * -x, filter: 'blur(4px)' }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="min-w-0"
    >
      {children}
    </Motion.div>
  );
};

// Phone & UX phase (2026-11-26): only these views read the shared
// workReports listener; the other views don't pay for its snapshots.
const DASHBOARD_VIEWS = ['home', 'rapport', 'statistics', 'fichier', 'settings'];

const AuthenticatedApp = ({ user, activeView, setActiveView, theme, onToggleTheme, accent, onAccentChange, isThemeExempt, effectiveTheme, effectiveAccent }) => {
  const dashboardData = useDashboardData(user, DASHBOARD_VIEWS.includes(activeView));
  // Batch 2: direction is now derived with the "adjust state during
  // render" pattern instead of reading prevViewRef.current during
  // render (react-hooks/refs). When the view changes, direction is
  // recomputed in the same render pass, so the entering view always
  // slides from the correct side.
  const [prevView, setPrevView] = useState(activeView);
  const [direction, setDirection] = useState(1);
  if (activeView !== prevView) {
    setDirection(VIEW_ORDER.indexOf(activeView) >= VIEW_ORDER.indexOf(prevView) ? 1 : -1);
    setPrevView(activeView);
  }

  return (
    <DashboardLayout activeView={activeView} setActiveView={setActiveView} theme={effectiveTheme} onToggleTheme={isThemeExempt ? null : onToggleTheme} accent={effectiveAccent} onAccentChange={isThemeExempt ? null : onAccentChange} isThemeExempt={isThemeExempt}>
      <AnimatePresence mode="wait">
        {activeView === 'home' && (
          <PageTransition key="home" viewKey="home" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <DashboardHome
                stats={dashboardData.stats}
                dataList={dashboardData.dataList}
                chartData={dashboardData.chartData}
                theme={theme}
                accent={accent}
              />
            </Suspense>
          </PageTransition>
        )}
        {activeView === 'pointage' && (
          <PageTransition key="pointage" viewKey="pointage" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <PointageView user={user} />
            </Suspense>
          </PageTransition>
        )}
        {activeView === 'rapport' && (
          <PageTransition key="rapport" viewKey="rapport" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <MonthlyReportView
                {...dashboardData}
              />
            </Suspense>
          </PageTransition>
        )}
        {activeView === 'refection' && (
          <PageTransition key="refection" viewKey="refection" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <RefectionView user={user} />
            </Suspense>
          </PageTransition>
        )}
        {activeView === 'statistics' && (
          <PageTransition key="statistics" viewKey="statistics" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <StatisticsView dataList={dashboardData.dataList} theme={theme} accent={accent} />
            </Suspense>
          </PageTransition>
        )}
        {activeView === 'fichier' && (
          <PageTransition key="fichier" viewKey="fichier" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <FichierExploitationEauView user={user} {...dashboardData} />
            </Suspense>
          </PageTransition>
        )}

        {activeView === 'srm-excel' && (
          <PageTransition key="srm-excel" viewKey="srm-excel" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <div className="p-4 md:p-6 max-w-4xl mx-auto">
                <SRMExcelImporter />
              </div>
            </Suspense>
          </PageTransition>
        )}

        {/* Enveloppe block: outside the srm-excel block */}
        {activeView === 'enveloppe' && (
          <PageTransition key="enveloppe" viewKey="enveloppe" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <EnveloppeFinanciereView user={user} />
            </Suspense>
          </PageTransition>
        )}

        {activeView === 'settings' && (
          <PageTransition key="settings" viewKey="settings" direction={direction}>
            <Suspense fallback={<ViewFallback />}>
              <SettingsView
                typeOptions={dashboardData.typeOptions}
                natureOptions={dashboardData.natureOptions}
                handleAddOption={dashboardData.handleAddOption}
                handleRemoveOption={dashboardData.handleRemoveOption}
              />
            </Suspense>
          </PageTransition>
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
};

const KNOWN_VIEWS = ['home', 'pointage', 'rapport', 'refection', 'statistics', 'fichier', 'srm-excel', 'enveloppe', 'settings'];

function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  // Refresh fix (copy only, also applied to original): the active view
  // used to live only in React state, so a refresh always reset it to
  // 'home'. It is now saved in localStorage on every change and
  // restored on load (invalid values fall back to 'home'), so a
  // refresh on Réfection stays on Réfection — and the same holds for
  // every other view. No view file, data or route was changed.
  const [activeView, setActiveView] = useState(() => {
    try {
      // Phone & UX phase (2026-11-26): a #view hash in the URL wins over
      // the saved view, so a shared link opens on the right page.
      const hash = window.location.hash.replace('#', '');
      if (KNOWN_VIEWS.includes(hash)) return hash;
      const saved = localStorage.getItem('hydraucan-active-view');
      return KNOWN_VIEWS.includes(saved) ? saved : 'home';
    } catch { return 'home'; }
  });
  useEffect(() => {
    try { localStorage.setItem('hydraucan-active-view', activeView); } catch { /* storage unavailable — keep in-memory default */ }
    // Keep the URL hash in sync so a view can be linked and the browser
    // back button walks back through views.
    if (window.location.hash !== `#${activeView}`) {
      window.history.pushState(null, '', `#${activeView}`);
    }
  }, [activeView]);
  useEffect(() => {
    const onPopState = () => {
      const hash = window.location.hash.replace('#', '');
      if (KNOWN_VIEWS.includes(hash)) setActiveView(hash);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  // Phone & UX phase (2026-11-26): toast position follows the screen —
  // bottom-center on phones (reachable by thumb), top-right on desktop.
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('hydraucan-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  const [accent, setAccent] = useState(() => {
    try { return getAccent(localStorage.getItem('hydraucan-accent')).id; } catch { return 'navy'; }
  });

  // User's saved choices are kept even while an exempt view is shown;
  // only what is applied to <html> is overridden there.
  useEffect(() => {
    try { localStorage.setItem('hydraucan-theme', theme); } catch { /* storage unavailable — keep in-memory default */ }
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem('hydraucan-accent', accent); } catch { /* storage unavailable — keep in-memory default */ }
  }, [accent]);

  const isThemeExempt = EXEMPT_VIEWS.includes(activeView);
  const effectiveTheme = isThemeExempt ? 'light' : theme;
  const effectiveAccent = isThemeExempt ? 'navy' : accent;

  useEffect(() => {
    document.documentElement.classList.toggle('theme-dark', effectiveTheme === 'dark');
    document.documentElement.dataset.accent = effectiveAccent;
  }, [effectiveTheme, effectiveAccent]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Phone & UX phase (2026-11-26): on sign-out only, drop any Enveloppe
  // drafts so the next worker on a shared tablet doesn't see the
  // previous one's in-progress report. Drafts are NOT cleared while
  // signed in (a refresh must keep them for restore).
  const prevUserRef = useRef(user);
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = user;
    if (prev && !user) {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith('hydraucan-enveloppe-draft-')).forEach((k) => localStorage.removeItem(k));
      } catch { /* storage unavailable — nothing to clear */ }
    }
  }, [user]);

  if (authLoading) {
    // Transitions Batch 3 (copy only): skeleton loader and reveal,
    // in the transitions.dev "skeleton loader and reveal" style —
    // rebuilt locally. While auth resolves, a skeleton of the real
    // shell (sidebar, top bar, KPI row, chart cards) pulses; when
    // the user is known, the authenticated app below fades in
    // (see the Motion wrapper on its return). No data is shown
    // here, only placeholders.
    return (
      <div className={`min-h-screen flex ${theme === 'dark' ? 'bg-[#0B1220]' : 'bg-[#EDF1F5]'}`} aria-label="Chargement">
        <div className="hidden lg:block w-[240px] shrink-0 p-6 space-y-4">
          <div className="h-12 rounded-lg bg-slate-300/60 animate-pulse" />
          <div className="h-16 rounded-lg bg-slate-300/40 animate-pulse" />
          <div className="h-10 rounded-lg bg-slate-300/40 animate-pulse" />
          <div className="h-10 rounded-lg bg-slate-300/40 animate-pulse" />
          <div className="h-10 rounded-lg bg-slate-300/40 animate-pulse" />
        </div>
        <div className="flex-1 min-w-0 p-2">
          <div className="h-12 rounded-lg bg-slate-300/40 animate-pulse mb-2" />
          <div className={`rounded-2xl border p-6 space-y-4 ${theme === 'dark' ? 'bg-[#1E293B] border-[#334155]' : 'bg-white border-line'}`}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="h-24 rounded-xl bg-slate-200/70 animate-pulse" />
              <div className="h-24 rounded-xl bg-slate-200/70 animate-pulse" />
              <div className="h-24 rounded-xl bg-slate-200/70 animate-pulse" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="h-64 rounded-xl bg-slate-200/70 animate-pulse" />
              <div className="h-64 rounded-xl bg-slate-200/70 animate-pulse" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'bg-[#0B1220]' : 'bg-[#EDF1F5]'}`}>
        <header className="bg-[#16294D] text-white">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <img src="/logo-hydracane.png" alt="HYDRAUCAN" className="h-8 sm:h-10 w-auto object-contain brightness-200" />
            <div className="flex items-center gap-3">
              <AccentPicker accent={accent} onAccentChange={setAccent} />
              <button onClick={toggleTheme} aria-label="Changer de thème" className="inline-flex items-center gap-1.5 rounded-full bg-white/10 border border-white/20 px-3 py-1 text-[11px] font-bold hover:bg-white/20 transition">
                {theme === 'dark' ? 'Clair' : 'Sombre'}
              </button>
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-white/10 border border-white/20 px-3 py-1 text-[11px] font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF]" /> Espace employés
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
    <Motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }}>
      <Toaster position={isMobile ? 'bottom-center' : 'top-right'} richColors />
      <AuthenticatedApp user={user} activeView={activeView} setActiveView={setActiveView} theme={theme} onToggleTheme={toggleTheme} accent={accent} onAccentChange={setAccent} isThemeExempt={isThemeExempt} effectiveTheme={effectiveTheme} effectiveAccent={effectiveAccent} />
    </Motion.div>
  );
}

export default App;