import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { RuntimeConfig } from '@osint/shared';
import { ConsoleShell } from './shell/ConsoleShell.js';
import { TabbedPanel, type TabDef } from './shell/TabbedPanel.js';
import { CommandBar } from './command-bar/CommandBar.js';
import { useImagery } from './state/stores.js';
import { LayerRail } from './layer-rail/LayerRail.js';
import { OpsPanel } from './layer-rail/OpsPanel.js';
import { ImageryControl } from './imagery/ImageryControl.js';
import { ChokepointsList } from './layer-rail/ChokepointsList.js';
import { FeedsPanel } from './layer-rail/FeedsPanel.js';
import { EntityPanel } from './entity-panel/EntityPanel.js';
import { IntelPanel } from './entity-panel/IntelPanel.js';
import { NewsPanel } from './news-panel/NewsPanel.js';
import { Timeline } from './timeline/Timeline.js';
import { GlobeCanvas } from './globe/GlobeCanvas.js';
import { GlobeOverlays } from './globe/GlobeOverlays.js';
import { GlobeTheater } from './globe/GlobeTheater.js';
import { AgentConsole } from './command-bar/AgentConsole.js';
import { LayerRegistry } from './registry/LayerRegistry.js';
import { registerDefaults } from './registry/defaults.js';
import { fetchRuntimeConfig } from './transport/config.js';
import { AlertSubscriber } from './alerts/AlertSubscriber.js';
import { AlertsPanel } from './alerts/AlertsPanel.js';
import { AlertsRailList } from './alerts/AlertsRailList.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { Link } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.js';
import { isSupabaseConfigured } from './transport/supabase.js';
import { resetToTopDown } from './globe/camera.js';

export function App(): JSX.Element {
  const registry = useMemo(() => {
    const r = new LayerRegistry();
    registerDefaults(r);
    return r;
  }, []);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const imageryMode = useImagery((s) => s.mode);

  useEffect(() => {
    fetchRuntimeConfig()
      .then(setConfig)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Global keyboard shortcut: `a` toggles the Alerts panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'a' || e.key === 'A') setAlertsOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onViewerReady = useCallback((v: Cesium.Viewer | null) => setViewer(v), []);

  const leftTabs: TabDef[] = useMemo(
    () => [
      {
        id: 'ops',
        label: 'Ops',
        content: <OpsPanel viewer={viewer} onOpenAlerts={() => setAlertsOpen(true)} />,
      },
      { id: 'layers', label: 'Layers', content: <LayerRail registry={registry} viewer={viewer} /> },
      { id: 'imagery', label: 'Imagery', content: <ImageryControl /> },
      { id: 'chokepoints', label: 'Chokepoints', content: <ChokepointsList viewer={viewer} /> },
      { id: 'feeds', label: 'Feeds', content: <FeedsPanel /> },
    ],
    [registry, viewer],
  );

  const rightTabs: TabDef[] = useMemo(
    () => [
      { id: 'selection', label: 'Selection', content: <EntityPanel viewer={viewer} /> },
      { id: 'alerts', label: 'Alerts', content: <AlertsRailList viewer={viewer} /> },
      { id: 'intel', label: 'Intel', content: <IntelPanel viewer={viewer} /> },
      { id: 'news', label: 'News', content: <NewsPanel /> },
    ],
    [viewer],
  );

  return (
    <>
      <AlertSubscriber />
      <ConsoleShell
        top={
          <CommandBar
            viewer={viewer}
            classification={config?.classification ?? 'UNCLAS'}
            ionToken={config?.cesiumIonToken ?? ''}
            onOpenAlerts={() => setAlertsOpen(true)}
          />
        }
        left={<TabbedPanel tabs={leftTabs} defaultTab="ops" ariaLabel="Left rail tabs" />}
        leftTabs={leftTabs}
        globe={
          error ? (
            <BootError message={error} />
          ) : config ? (
            <>
              <ErrorBoundary label="globe">
                <GlobeCanvas
                  ionToken={config.cesiumIonToken}
                  registry={registry}
                  onViewerReady={onViewerReady}
                  imageryMode={imageryMode}
                  enableGoogle3D={config.features.enableGoogle3D}
                  googleApiKey={config.googleApiKey}
                />
              </ErrorBoundary>
              {/* Instrument overlays + resting command dock float over the globe.
                  Both are null/viewer-safe and pointer-scoped so they never
                  block globe interaction. */}
              <GlobeTheater viewer={viewer} />
              <GlobeOverlays viewer={viewer} />
              <GlobeControls viewer={viewer} />
              <AuthNotice />
              <AgentConsole viewer={viewer} />
            </>
          ) : (
            <BootLoading />
          )
        }
        right={<TabbedPanel tabs={rightTabs} defaultTab="selection" ariaLabel="Right rail tabs" />}
        rightTabs={rightTabs}
        bottom={<ErrorBoundary label="Timeline"><Timeline viewer={viewer} /></ErrorBoundary>}
      />
      <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} viewer={viewer} />
    </>
  );
}

// Floating globe controls. A reset-to-top-down button (removes camera tilt /
// "side view" without losing the analyst's location) — the most-requested
// orientation control.
function GlobeControls({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  if (!viewer) return null;
  return (
    <div className="absolute bottom-3 right-3 z-[1200] flex flex-col gap-1.5">
      <button
        type="button"
        title="Reset to top-down (nadir) view"
        onClick={() => resetToTopDown(viewer)}
        className="mono text-[10px] px-2 py-1 border border-line rounded-sm bg-bg-1/90 text-txt-1 hover:border-accent-line hover:text-accent"
      >
        ⊕ Top-down
      </button>
    </div>
  );
}

// Prominent "you're not signed in" notice. On the hosted backend every data
// endpoint is auth-gated, so a logged-out visitor sees an empty globe and
// assumes it's broken. This makes the real reason explicit with a one-click
// path to sign in. Only shows when auth is configured AND the first session
// check has resolved to "no user".
function AuthNotice(): JSX.Element | null {
  const { user, loading } = useAuth();
  if (loading || user || !isSupabaseConfigured) return null;
  return (
    <div className="absolute inset-x-0 top-10 z-[1500] flex justify-center px-3 pointer-events-none">
      <div className="pointer-events-auto bg-bg-1/95 border border-accent-line rounded-md px-4 py-3 shadow-xl max-w-sm text-center">
        <p className="text-txt-0 text-[13px] font-semibold">Sign in to load live data</p>
        <p className="text-txt-2 text-[11px] mt-1 leading-snug">
          Live aircraft, vessels &amp; intel need an account — the globe stays blank until you sign
          in.
        </p>
        <Link
          to="/login"
          className="inline-block mt-2.5 px-3 py-1 rounded-sm text-[12px] font-medium"
          style={{ background: 'var(--accent)', color: '#06121a' }}
        >
          Sign in →
        </Link>
      </div>
    </div>
  );
}

function BootLoading(): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <span className="micro">loading config…</span>
    </div>
  );
}

function BootError({ message }: { message: string }): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="border border-alert/40 bg-alert-bg px-4 py-3 rounded-md">
        <div className="micro text-alert">config error</div>
        <div className="mono text-[11px] text-txt-1 mt-1">{message}</div>
      </div>
    </div>
  );
}
