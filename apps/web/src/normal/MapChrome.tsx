// MapChrome — Palantir-Gotham floating map chrome for the Normal dashboard (images 25/27), MVP.
// Renders over the globe (the center section is position:relative; these are absolute + z-scoped):
//   • left vertical toolbar  — pin · measure · route · search · erase (reuses globe/draw)
//   • bottom-right quick toggles — Air/Maritime/Space/Hazards primary layers (registry)
//   • bottom-left basemap switch — Dark ↔ Satellite (useImagery)
//   • bottom-center status bar — "Map health · Connected" (useFeeds)
// Scale bar / north compass / coordinate readout already come from globe/GlobeOverlays.
import { useEffect, useMemo, useState } from 'react';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds, feedStatusSignature, useImagery, type FeedHealth } from '../state/stores.js';
import { getDrawController, haversineKm, type LatLon } from '../globe/draw.js';
import { Icon, type IconName } from './Icon.js';

export interface MapChromeProps {
  registry: LayerRegistry;
  onOpenWorkspace?: (mode: 'search' | 'route') => void;
}

// Bottom-right quick toggles → the primary layer for each domain.
const QUICK: { id: string; icon: IconName; label: string }[] = [
  { id: 'aviation.adsb.global', icon: 'plane', label: 'Air' },
  { id: 'maritime.keyless', icon: 'ship', label: 'Maritime' },
  { id: 'space.celestrak.stations', icon: 'satellite', label: 'Space' },
  { id: 'hazards.nasa.firms', icon: 'fire', label: 'Hazards' },
];

export function MapChrome({ registry, onOpenWorkspace }: MapChromeProps): JSX.Element {
  // Gate on the status signature: map-health only depends on how many feeds are
  // red/amber/green, which changes rarely — not on every poll's lastSeen tick.
  const feedsSig = useFeeds((s) => feedStatusSignature(s.feeds));
  const mode = useImagery((s) => s.mode);
  const setMode = useImagery((s) => s.setMode);
  const [, setTick] = useState(0);
  const [measureKm, setMeasureKm] = useState<number | null>(null);
  useEffect(() => registry.subscribe(() => setTick((n) => n + 1)), [registry]);

  const health = useMemo((): { tone: string; text: string } => {
    const vals = Object.values(useFeeds.getState().feeds) as FeedHealth[];
    if (vals.length === 0) return { tone: 'off', text: 'No feeds' };
    const down = vals.filter((f) => f.status === 'red').length;
    const deg = vals.filter((f) => f.status === 'amber').length;
    const up = vals.filter((f) => f.status === 'green').length;
    if (down > 0) return { tone: 'red', text: `${down} down` };
    if (deg > 0) return { tone: 'amber', text: `Degraded · ${deg}` };
    if (up > 0) return { tone: 'green', text: 'Connected' };
    return { tone: 'off', text: 'Idle' };
  }, [feedsSig]);

  const measure = (): void => {
    getDrawController()?.drawPolyline((verts: LatLon[]) => {
      let km = 0;
      for (let i = 1; i < verts.length; i += 1) km += haversineKm(verts[i - 1]!, verts[i]!);
      setMeasureKm(km);
    });
  };

  const tools: { id: string; icon: IconName; title: string; act: () => void }[] = [
    { id: 'pin', icon: 'pin', title: 'Drop pin', act: () => getDrawController()?.placePoint(() => {}) },
    { id: 'measure', icon: 'route', title: 'Measure distance', act: measure },
    { id: 'route', icon: 'route', title: 'Route & simulate', act: () => onOpenWorkspace?.('route') },
    { id: 'search', icon: 'search', title: 'Search objects', act: () => onOpenWorkspace?.('search') },
    { id: 'erase', icon: 'x', title: 'Clear drawing', act: () => getDrawController()?.cancel() },
  ];

  return (
    <>
      {/* Left vertical toolbar */}
      <div className="nrm-maptools">
        {tools.map((t) => (
          <button key={t.id} type="button" title={t.title} aria-label={t.title} onClick={t.act}>
            <Icon name={t.icon} className="ico" />
          </button>
        ))}
        {measureKm != null && <span className="nrm-measure">{measureKm.toFixed(1)} km</span>}
      </div>

      {/* Bottom-right quick layer toggles */}
      <div className="nrm-quicktoggles">
        {QUICK.map((qk) => {
          const on = registry.isEnabled(qk.id);
          return (
            <button
              key={qk.id}
              type="button"
              title={qk.label}
              aria-label={qk.label}
              aria-pressed={on}
              className={on ? 'on' : ''}
              onClick={() => (on ? registry.disable(qk.id) : registry.enable(qk.id))}
            >
              <Icon name={qk.icon} className="ico" />
            </button>
          );
        })}
      </div>

      {/* Bottom-left basemap switch */}
      <button
        type="button"
        className="nrm-basemap"
        onClick={() => setMode(mode === '3d-sat' ? '2d-dark' : '3d-sat')}
        title="Toggle basemap"
      >
        <Icon name="map" className="ico" />
        <span>{mode === '3d-sat' ? 'Satellite' : 'Dark'}</span>
      </button>

      {/* Bottom-center status bar */}
      <div className="nrm-maphealth">
        <span className={`dot ${health.tone}`} aria-hidden="true" />
        <span>Map health · {health.text}</span>
      </div>
    </>
  );
}
