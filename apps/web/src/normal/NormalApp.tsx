// The "Normal" dashboard — an approachable Gotham-style console that renders the
// SAME globe stack as the Professional App (App.tsx): identical GlobeCanvas props,
// identical registry/adapters, so the aircraft / heli / glider / vessel map icons
// and every refresh-optimization are byte-for-byte the same. Only the surrounding
// chrome (top bar, rails, timeline frame, responsive scaling) differs. The
// Professional dashboard stays untouched and is reachable from the user menu /
// settings (dashboardMode store).
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import type { RuntimeConfig } from '@osint/shared';
import { NormalShell } from './NormalShell.js';
import { NormalTopBar, type NormalSection } from './NormalTopBar.js';
import { LayerRegistry } from '../registry/LayerRegistry.js';
import { registerDefaults } from '../registry/defaults.js';
import { fetchRuntimeConfig } from '../transport/config.js';
import { useImagery, useSim } from '../state/stores.js';
import { GlobeCanvas } from '../globe/GlobeCanvas.js';
import { GlobeTheater } from '../globe/GlobeTheater.js';
import { GlobeOverlays } from '../globe/GlobeOverlays.js';
import { ContextMenu } from '../globe/ContextMenu.js';
import { ImageryDiffPopup } from '../imagery/ImageryDiff.js';
import { Omnibar } from '../command-bar/Omnibar.js';
import { SimulationOverlay } from '../sim/SimulationOverlay.js';
import { NormalLayerRail } from './NormalLayerRail.js';
import { NormalSelection } from './NormalSelection.js';
import { NormalTimeline } from './NormalTimeline.js';
import { TabbedPanel, type TabDef } from '../shell/TabbedPanel.js';
import { IntelPanel } from '../entity-panel/IntelPanel.js';
import { AlertsRailList } from '../alerts/AlertsRailList.js';
import { NewsPanel } from '../news-panel/NewsPanel.js';
import { InvestigationCanvas } from '../graph/InvestigationCanvas.js';
import { CollabPanel } from '../collab/CollabPanel.js';
import { HistogramPanel } from '../explorer/HistogramPanel.js';
import { GroundReconPanel } from '../ground/GroundReconPanel.js';
import { FieldPanel } from '../field/FieldPanel.js';
import { AlertSubscriber } from '../alerts/AlertSubscriber.js';
import { AlertsPanel } from '../alerts/AlertsPanel.js';
import { SettingsModal } from '../settings/SettingsModal.js';
import { ErrorBoundary } from '../shell/ErrorBoundary.js';

// Section nav → which panel fills the left rail. 'assistant' is an ACTION
// (opens the omnibar) rather than a panel, so it never becomes the active panel.
const SECTIONS: NormalSection[] = [
  { id: 'all', label: 'All layers', icon: 'layers' },
  { id: 'aviation', label: 'Air', icon: 'plane' },
  { id: 'maritime', label: 'Maritime', icon: 'ship' },
  { id: 'space', label: 'Space', icon: 'satellite' },
  { id: 'hazards', label: 'Hazards', icon: 'fire' },
  { id: 'assistant', label: 'Assistant', icon: 'sparkle' },
];

export function NormalApp(): JSX.Element {
  const registry = useMemo(() => {
    const r = new LayerRegistry();
    registerDefaults(r);
    return r;
  }, []);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('all');
  const imageryMode = useImagery((s) => s.mode);
  const sim = useSim((s) => s.active);

  useEffect(() => {
    fetchRuntimeConfig()
      .then(setConfig)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const onViewerReady = useCallback((v: Cesium.Viewer | null) => setViewer(v), []);

  // Omnibar (⌘K) is always mounted in the globe stack and listens for the
  // shortcut itself; the top bar's search/assistant button replays it.
  const openOmnibar = useCallback(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  }, []);

  // `a` toggles Alerts (parity with the Professional dashboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'a' || e.key === 'A') setAlertsOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSection = useCallback(
    (id: string) => {
      if (id === 'assistant') openOmnibar();
      else setActiveSection(id);
    },
    [openOmnibar],
  );

  const leftPanel = (
    <NormalLayerRail
      registry={registry}
      viewer={viewer}
      filterGroup={activeSection === 'all' ? null : activeSection}
    />
  );

  // Right rail keeps the full Professional toolset (Intel / Alerts / News /
  // Investigation / Collab / Filters / Ground / Field=traffic) — only the
  // Selection tab is the clean Normal dossier. Nothing is dropped.
  const rightTabs: TabDef[] = useMemo(
    () => [
      { id: 'selection', label: 'Selection', content: <NormalSelection viewer={viewer} /> },
      { id: 'intel', label: 'Intel', content: <IntelPanel viewer={viewer} /> },
      { id: 'alerts', label: 'Alerts', content: <AlertsRailList viewer={viewer} /> },
      { id: 'news', label: 'News', content: <NewsPanel /> },
      { id: 'field', label: 'Field', content: <FieldPanel viewer={viewer} /> },
      { id: 'investigation', label: 'Investigation', content: <InvestigationCanvas /> },
      { id: 'collab', label: 'Collab', content: <CollabPanel /> },
      { id: 'filters', label: 'Filters', content: <HistogramPanel viewer={viewer} /> },
      { id: 'ground', label: 'Ground', content: <GroundReconPanel viewer={viewer} /> },
    ],
    [viewer],
  );

  const globe =
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
        <GlobeTheater viewer={viewer} />
        <GlobeOverlays viewer={viewer} />
        <Omnibar viewer={viewer} registry={registry} />
        <ContextMenu />
        <ImageryDiffPopup />
      </>
    ) : (
      <BootLoading />
    );

  return (
    <>
      <AlertSubscriber />
      <NormalShell
        exercise={sim}
        classification="Unclassified // Open-source intelligence"
        top={
          <NormalTopBar
            sections={SECTIONS}
            activeSection={activeSection}
            onSection={onSection}
            onOpenSearch={openOmnibar}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        }
        globe={globe}
        left={leftPanel}
        right={
          <TabbedPanel
            tabs={rightTabs}
            variant="menu"
            defaultTab="selection"
            ariaLabel="Right rail tabs"
          />
        }
        bottom={
          <ErrorBoundary label="Timeline">
            <NormalTimeline viewer={viewer} />
          </ErrorBoundary>
        }
      />
      <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} viewer={viewer} />
      <SimulationOverlay viewer={viewer} registry={registry} />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </>
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
