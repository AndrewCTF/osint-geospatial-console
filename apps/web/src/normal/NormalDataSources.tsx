// NormalDataSources — the "Data sources" tab of the Normal dashboard's Palantir-Gotham left
// rail (reference image 25). Three count-badged sections:
//   • Live data layers   — the RAW per-source toggle list (adsb.fi / OpenSky / AISStream / each
//                          SAR window / each satellite group). The escape hatch hidden from the
//                          clean Map-layers tab. Wired to LayerRegistry + useFeeds health dots.
//   • Integrated sources — the analyst panels that ARE data sources (Feeds / ACARS / Situations /
//                          Chat), opened inline as an accordion; Target boards opens the workspace.
//   • Reference          — basemap (useImagery) + the notional COP layer.
// Plus a "Map health · Connected" footer aggregating useFeeds.
import { useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerDescriptor } from '@osint/shared';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds, feedStatusSignature, useImagery, type FeedHealth } from '../state/stores.js';
import { Icon, type IconName } from './Icon.js';
import { HIDDEN_SOURCE_IDS } from './layerCatalog.js';
import { FeedsPanel } from '../layer-rail/FeedsPanel.js';
import { AcarsPanel } from '../acars/AcarsPanel.js';
import { SituationsPanel } from '../situations/SituationsPanel.js';
import { CollabPanel } from '../collab/CollabPanel.js';

export interface NormalDataSourcesProps {
  registry: LayerRegistry;
  viewer: Cesium.Viewer | null;
  /** Open a full-surface workspace (Target boards). */
  onOpenWorkspace?: (mode: 'targeting') => void;
}

const REFERENCE_IDS = new Set(['mil.cop.notional']);

// A raw source layer counts as "live" when it pulls/pushes (not a static reference layer).
function isLiveLayer(l: LayerDescriptor): boolean {
  return !REFERENCE_IDS.has(l.id);
}

type DotTone = 'green' | 'amber' | 'red' | 'blue' | 'off';

function tokens(...parts: readonly string[]): readonly string[] {
  return parts.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}
function feedMatches(layer: LayerDescriptor, feed: FeedHealth): boolean {
  const lid = layer.id.toLowerCase();
  const fid = feed.id.toLowerCase();
  if (fid.length >= 3 && (lid.includes(fid) || fid.includes(lid))) return true;
  const ftoks = new Set(tokens(feed.id, feed.label));
  return tokens(layer.id, layer.title).some((t) => ftoks.has(t));
}
function layerTone(layer: LayerDescriptor, feeds: Record<string, FeedHealth>, enabled: boolean): DotTone {
  let matched: DotTone | null = null;
  for (const feed of Object.values(feeds)) {
    if (!feedMatches(layer, feed)) continue;
    if (feed.status === 'green') return 'green';
    if (feed.status === 'amber') matched = 'amber';
    else if (feed.status === 'red' && matched !== 'amber') matched = 'red';
  }
  return matched ?? (enabled ? 'blue' : 'off');
}

export function NormalDataSources(props: NormalDataSourcesProps): JSX.Element {
  const { registry, viewer, onOpenWorkspace } = props;
  // Status signature gate (see stores.feedStatusSignature): re-render on a dot
  // colour change, not every poll heartbeat. tones + health read the live map
  // via getState() inside memos keyed on this signature.
  const feedsSig = useFeeds((s) => feedStatusSignature(s.feeds));
  const imageryMode = useImagery((s) => s.mode);
  const setImageryMode = useImagery((s) => s.setMode);

  const [tick, setTick] = useState(0);
  useEffect(() => registry.subscribe(() => setTick((n) => n + 1)), [registry]);

  const layers = registry.list();
  const live = useMemo(() => layers.filter(isLiveLayer), [layers]);
  const referenceLayers = useMemo(() => layers.filter((l) => REFERENCE_IDS.has(l.id)), [layers]);

  const liveOn = live.reduce((n, l) => n + (registry.isEnabled(l.id) ? 1 : 0), 0);
  const toggle = (id: string): void => (registry.isEnabled(id) ? registry.disable(id) : registry.enable(id));

  // Which integrated-source accordion is expanded (only one at a time keeps the rail short).
  const [openPanel, setOpenPanel] = useState<string | null>(null);

  // Precompute each live layer's dot ONCE per (status-change | toggle) instead of
  // O(layers×feeds) on every render.
  const tones = useMemo(() => {
    const feeds = useFeeds.getState().feeds;
    const m = new Map<string, DotTone>();
    for (const l of live) m.set(l.id, layerTone(l, feeds, registry.isEnabled(l.id)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedsSig, tick, live, registry]);

  // Aggregate feed health → footer.
  const health = useMemo((): { tone: DotTone; text: string } => {
    const vals = Object.values(useFeeds.getState().feeds);
    if (vals.length === 0) return { tone: 'off', text: 'No feeds' };
    const down = vals.filter((f) => f.status === 'red').length;
    const deg = vals.filter((f) => f.status === 'amber').length;
    const up = vals.filter((f) => f.status === 'green').length;
    if (down > 0) return { tone: 'red', text: `${down} feed${down === 1 ? '' : 's'} down` };
    if (deg > 0) return { tone: 'amber', text: `Degraded · ${deg}` };
    if (up > 0) return { tone: 'green', text: 'Connected' };
    return { tone: 'off', text: 'Idle' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedsSig]);

  const integrated: { id: string; label: string; icon: IconName; node?: JSX.Element; onClick?: () => void }[] = [
    { id: 'feeds', label: 'Feeds', icon: 'feed', node: <FeedsPanel /> },
    { id: 'acars', label: 'ACARS', icon: 'plane', node: <AcarsPanel /> },
    { id: 'situations', label: 'Situations', icon: 'file', node: <SituationsPanel viewer={viewer} /> },
    { id: 'chat', label: 'Chat', icon: 'network', node: <CollabPanel /> },
    { id: 'targets', label: 'Target boards', icon: 'target', onClick: () => onOpenWorkspace?.('targeting') },
  ];

  return (
    <div className="railbody">
      {/* ── Live data layers ─────────────────────────────────────────────── */}
      <div className="ds-section-head">
        <span className="gname">Live data layers</span>
        <span className="badge">{liveOn} / {live.length}</span>
      </div>
      <div className="group-body">
        {live.map((l) => {
          const enabled = registry.isEnabled(l.id);
          const tone = tones.get(l.id) ?? (enabled ? 'blue' : 'off');
          const hidden = HIDDEN_SOURCE_IDS.includes(l.id);
          return (
            <div className={enabled ? 'row sel' : 'row'} key={l.id} onClick={() => toggle(l.id)}>
              <span className={`dot ${tone}`} aria-hidden="true" />
              <span className="nm" title={hidden ? `${l.title} (source feed)` : l.title}>
                {l.title}
              </span>
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={enabled}
                aria-label={l.title}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(l.id);
                }}
              />
            </div>
          );
        })}
      </div>

      {/* ── Integrated data sources ──────────────────────────────────────── */}
      <div className="ds-section-head" style={{ marginTop: '0.6em' }}>
        <span className="gname">Integrated data sources</span>
        <span className="badge">{integrated.length}</span>
      </div>
      <div className="group-body">
        {integrated.map((it) => {
          const open = openPanel === it.id;
          return (
            <div key={it.id}>
              <div
                className="row"
                onClick={() => (it.onClick ? it.onClick() : setOpenPanel(open ? null : it.id))}
              >
                <Icon name={it.icon} className="ico" />
                <span className="nm">{it.label}</span>
                <Icon name={it.onClick ? 'expand' : open ? 'chevron-down' : 'chevron-right'} className="chev" />
              </div>
              {open && it.node && (
                <div className="ds-embed" onClick={(e) => e.stopPropagation()}>
                  {it.node}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Reference data layers ────────────────────────────────────────── */}
      <div className="ds-section-head" style={{ marginTop: '0.6em' }}>
        <span className="gname">Reference data layers</span>
        <span className="badge">{referenceLayers.length + 1}</span>
      </div>
      <div className="group-body">
        <div className="row" onClick={() => setImageryMode(imageryMode === '3d-sat' ? '2d-dark' : '3d-sat')}>
          <Icon name="map" className="ico" />
          <span className="nm">Basemap · {imageryMode === '3d-sat' ? 'Satellite' : 'Dark'}</span>
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={imageryMode === '3d-sat'}
            aria-label="Satellite basemap"
            onClick={(e) => {
              e.stopPropagation();
              setImageryMode(imageryMode === '3d-sat' ? '2d-dark' : '3d-sat');
            }}
          />
        </div>
        {referenceLayers.map((l) => {
          const enabled = registry.isEnabled(l.id);
          return (
            <div className={enabled ? 'row sel' : 'row'} key={l.id} onClick={() => toggle(l.id)}>
              <Icon name="layers" className="ico" />
              <span className="nm" title={l.title}>{l.title}</span>
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={enabled}
                aria-label={l.title}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(l.id);
                }}
              />
            </div>
          );
        })}
      </div>

      {/* ── Map health footer ────────────────────────────────────────────── */}
      <div
        className="row"
        style={{ cursor: 'default', marginTop: '0.5em', paddingTop: '0.5em', borderTop: '1px solid var(--line, rgba(255,255,255,0.08))' }}
      >
        <span className={`dot ${health.tone}`} aria-hidden="true" />
        <span className="nm" style={{ opacity: 0.85 }}>Map health</span>
        <span className="gcount">{health.text}</span>
      </div>
    </div>
  );
}
