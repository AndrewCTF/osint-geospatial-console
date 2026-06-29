// NormalLayerRail — the CLEAN grouped layer rail for the "Normal" dashboard,
// ported straight from the Gotham design mockup (dashboard.html · left rail).
//
// Unlike the dense Professional `LayerRail` (opacity sliders, "0 · NOW 100%"
// readouts, faceted controls) this rail is deliberately SIMPLE: collapsible
// domain groups ("Aviation / Maritime / Space / Hazards / …") whose rows are
// just a status dot + a domain icon + the layer title + an accessible toggle.
//
// It owns NO data of its own — every row is wired to the real `LayerRegistry`
// (enable/disable + isEnabled) and the live `useFeeds` store (the status dot).
// All look lives in ./normal.css under the `.nrm` scope; this file emits only
// structure + behaviour. Strict TS, NodeNext ESM (relative imports end in .js).
import { useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerDescriptor, LayerGroup } from '@osint/shared';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds, type FeedHealth, type FeedStatus } from '../state/stores.js';
import { Icon, type IconName } from './Icon.js';

export interface NormalLayerRailProps {
  registry: LayerRegistry;
  viewer: Cesium.Viewer | null;
  filterGroup?: string | null;
}

// Render order + display label for every domain group (per the design brief).
const GROUP_ORDER: readonly LayerGroup[] = [
  'conflict',
  'aviation',
  'maritime',
  'space',
  'hazards',
  'env',
  'news',
  'cyber',
  'infra',
  'rf',
  'signals',
  'imagery',
  'reference',
  'seismic',
];

const GROUP_LABEL: Record<LayerGroup, string> = {
  conflict: 'Conflict',
  aviation: 'Aviation',
  maritime: 'Maritime',
  space: 'Space',
  hazards: 'Hazards',
  env: 'Environment',
  news: 'OSINT/Events',
  cyber: 'Cyber/Intel',
  infra: 'Infrastructure',
  rf: 'RF/Signals',
  signals: 'Signals',
  imagery: 'Imagery',
  reference: 'Reference',
  seismic: 'Seismic',
};

// Domain icon for a group header (.gicon). Falls back to the generic stack.
const GROUP_ICON: Record<LayerGroup, IconName> = {
  conflict: 'crosshair',
  aviation: 'plane',
  maritime: 'ship',
  space: 'satellite',
  hazards: 'fire',
  env: 'fire',
  news: 'bell',
  cyber: 'signal',
  infra: 'layers',
  rf: 'signal',
  signals: 'signal',
  imagery: 'image',
  reference: 'layers',
  seismic: 'quake',
};

// Groups that start expanded; everything else collapses until clicked.
const DEFAULT_OPEN: ReadonlySet<LayerGroup> = new Set<LayerGroup>([
  'conflict',
  'aviation',
  'maritime',
]);

// Per-row domain icon (.ico). Prefer what the layer actually emits, else its
// group icon — keeps the row legible without a per-layer lookup table.
function rowIcon(layer: LayerDescriptor): IconName {
  const emit = layer.emits?.[0];
  switch (emit) {
    case 'aircraft':
      return 'plane';
    case 'vessel':
      return 'ship';
    case 'satellite':
      return 'satellite';
    case 'quake':
      return 'quake';
    case 'fire':
      return 'fire';
    case 'detection':
      return 'crosshair';
    case 'emitter':
    case 'outage':
      return 'signal';
    case 'event':
      return 'bell';
    case 'camera':
      return 'image';
    default:
      return GROUP_ICON[layer.group];
  }
}

type DotTone = 'green' | 'amber' | 'red' | 'blue' | 'off';

// Significant lowercase tokens (len ≥ 3) used for loose feed↔layer matching.
function tokens(...parts: readonly string[]): readonly string[] {
  return parts
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

// A feed "loosely matches" a layer when their ids nest, or they share a domain
// token (e.g. adsb / ais / satellite / quake). Deterministic, no fuzzy scoring.
function feedMatches(layer: LayerDescriptor, feed: FeedHealth): boolean {
  const lid = layer.id.toLowerCase();
  const fid = feed.id.toLowerCase();
  if (fid.length >= 3 && (lid.includes(fid) || fid.includes(lid))) return true;
  const ftoks = new Set(tokens(feed.id, feed.label));
  return tokens(layer.id, layer.title).some((t) => ftoks.has(t));
}

// Status dot: a matching feed's health wins (green/amber/red); otherwise the
// dot reflects whether the layer is enabled (blue) or off.
function dotTone(layer: LayerDescriptor, feeds: Record<string, FeedHealth>, enabled: boolean): DotTone {
  let matched: FeedStatus | null = null;
  for (const feed of Object.values(feeds)) {
    if (!feedMatches(layer, feed)) continue;
    if (feed.status === 'green') return 'green';
    if (matched === null || feed.status !== 'unknown') matched = feed.status;
  }
  if (matched === 'amber') return 'amber';
  if (matched === 'red') return 'red';
  return enabled ? 'blue' : 'off';
}

export function NormalLayerRail(props: NormalLayerRailProps): JSX.Element {
  const { registry, filterGroup } = props;
  const feeds = useFeeds((s) => s.feeds);

  // Live copy of the registry, refreshed whenever it emits (register / enable /
  // disable / …). `tick` also bumps so isEnabled() reads re-evaluate on toggle.
  const [layers, setLayers] = useState<readonly LayerDescriptor[]>(() => registry.list());
  const [, setTick] = useState(0);
  useEffect(() => {
    const unsub = registry.subscribe(() => {
      setLayers(registry.list());
      setTick((n) => n + 1);
    });
    setLayers(registry.list());
    return unsub;
  }, [registry]);

  const [query, setQuery] = useState('');
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});

  const q = query.trim().toLowerCase();
  const forceOpen = q.length > 0;

  // Bucket the (optionally text-filtered, optionally group-filtered) layers by
  // group, preserving registry order within each group.
  const grouped = useMemo(() => {
    const map = new Map<LayerGroup, LayerDescriptor[]>();
    for (const layer of layers) {
      if (filterGroup && layer.group !== filterGroup) continue;
      if (q.length > 0 && !layer.title.toLowerCase().includes(q)) continue;
      const bucket = map.get(layer.group) ?? [];
      bucket.push(layer);
      map.set(layer.group, bucket);
    }
    return map;
  }, [layers, filterGroup, q]);

  const onToggle = (id: string): void => {
    if (registry.isEnabled(id)) registry.disable(id);
    else registry.enable(id);
  };

  const isOpen = (group: LayerGroup): boolean =>
    forceOpen || (openOverrides[group] ?? DEFAULT_OPEN.has(group));

  const toggleOpen = (group: LayerGroup): void =>
    setOpenOverrides((prev) => ({ ...prev, [group]: !isOpen(group) }));

  const visibleGroups = GROUP_ORDER.filter((g) => (grouped.get(g)?.length ?? 0) > 0);

  return (
    <div className="railbody">
      {/* Minimal text filter (kept light per the mockup — no facet controls). */}
      <div className="row" style={{ cursor: 'default', marginBottom: '0.46em' }}>
        <Icon name="search" className="ico" />
        <input
          className="nm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter layers…"
          aria-label="Filter layers by name"
          style={{
            background: 'transparent',
            border: 0,
            outline: 'none',
            color: 'inherit',
            font: 'inherit',
            width: '100%',
          }}
        />
      </div>

      {visibleGroups.length === 0 ? (
        <p className="note">No layers match “{query}”.</p>
      ) : (
        visibleGroups.map((group) => {
          const rows = grouped.get(group) ?? [];
          const enabledCount = rows.reduce((n, l) => n + (registry.isEnabled(l.id) ? 1 : 0), 0);
          const open = isOpen(group);
          return (
            <section className={open ? 'group open' : 'group'} key={group}>
              <button
                type="button"
                className="group-head"
                aria-expanded={open}
                onClick={() => toggleOpen(group)}
                style={{ width: '100%', border: 0, background: 'none', textAlign: 'left' }}
              >
                <Icon name="chevron-right" className="chev" />
                <Icon name={GROUP_ICON[group]} className="gicon" />
                <span className="gname">{GROUP_LABEL[group]}</span>
                <span className="gcount">
                  {enabledCount} / {rows.length}
                </span>
              </button>
              {open && (
                <div className="group-body">
                  {rows.map((layer) => {
                    const enabled = registry.isEnabled(layer.id);
                    const tone = dotTone(layer, feeds, enabled);
                    return (
                      <div
                        className={enabled ? 'row sel' : 'row'}
                        key={layer.id}
                        onClick={() => onToggle(layer.id)}
                      >
                        <span className={`dot ${tone}`} aria-hidden="true" />
                        <Icon name={rowIcon(layer)} className="ico" />
                        <span className="nm" title={layer.title}>
                          {layer.title}
                        </span>
                        <button
                          type="button"
                          className="toggle"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={layer.title}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggle(layer.id);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
