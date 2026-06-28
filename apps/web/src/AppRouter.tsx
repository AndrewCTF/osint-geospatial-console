import { useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { App } from './App.js';
import { App2D } from './App2D.js';
import { NormalApp } from './normal/NormalApp.js';
import { useDashboardMode } from './state/dashboardMode.js';
import { StudioPage } from './studio/StudioPage.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { AuthForm } from './auth/AuthForm.js';
import { LoginPage } from './auth/LoginPage.js';
import { SignupPage } from './auth/SignupPage.js';
import { SettingsModal } from './settings/SettingsModal.js';
import { VelocityNewsPage } from './news/VelocityNewsPage.js';
import { StoryView } from './news/StoryView.js';

// Served under the Vite base path (e.g. "/app" in production, "/" in dev), so
// the router's basename tracks it — keeps client routes correct behind /app.
const BASENAME = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || '/';

export function AppRouter(): JSX.Element {
  return (
    <BrowserRouter basename={BASENAME}>
      <AuthProvider>
        <TopBar />
        <Routes>
          <Route path="/" element={<DashboardRoute />} />
          <Route path="/2d" element={<App2D />} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/news" element={<VelocityNewsPage />} />
          <Route path="/news/:id" element={<StoryView />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/forgot" element={<AuthForm mode="forgot" />} />
          <Route path="/reset" element={<AuthForm mode="reset" />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

// The "/" route renders either the new Normal dashboard (default) or the dense
// Professional dashboard (the original App), per the persisted dashboardMode.
// Both mount the identical globe stack — only the chrome differs.
function DashboardRoute(): JSX.Element {
  const mode = useDashboardMode((s) => s.mode);
  return mode === 'professional' ? <App /> : <NormalApp />;
}

function TopBar(): JSX.Element | null {
  const loc = useLocation();
  const { user } = useAuth();
  const mode = useDashboardMode((s) => s.mode);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The auth pages are full-screen cards — no overlay chrome on them.
  if (['/login', '/signup', '/forgot', '/reset'].includes(loc.pathname)) return null;
  if (loc.pathname.startsWith('/news')) return null;
  // On the Normal dashboard home the new top bar owns the account/settings/nav
  // chrome (its user menu), so the floating chip would collide — hide it there.
  if (loc.pathname === '/' && mode === 'normal') return null;
  const is2D = loc.pathname.startsWith('/2d');
  const isStudio = loc.pathname.startsWith('/studio');
  return (
    <div className="absolute top-1 right-2 z-[1000] flex items-center gap-2">
      {user && (
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="API keys & settings"
          className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
        >
          ⚙ Keys
        </button>
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <AccountChip />
      <div className="flex gap-1">
        <Link
          to="/"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${!is2D && !isStudio ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          3D
        </Link>
        <Link
          to="/2d"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${is2D ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          2D
        </Link>
        <Link
          to="/studio"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${isStudio ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          STUDIO
        </Link>
      </div>
    </div>
  );
}

function AccountChip(): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  if (loading) return null;
  if (!user) {
    return (
      <Link
        to="/login"
        className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
      >
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="mono text-[10px] text-txt-2" title={user.email ?? user.id}>
        {user.email ?? user.id.slice(0, 8)}
      </span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
      >
        Sign out
      </button>
    </div>
  );
}
