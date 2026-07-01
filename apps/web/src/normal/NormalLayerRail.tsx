// NormalLayerRail — the "Map layers" tab of the Normal dashboard's Palantir-Gotham left rail.
//
// Clean, Gotham-style: a few named collapsible FOLDERS of plain-English capability rows
// (Aircraft / Vessels / Earthquakes …) — NOT one row per feed source, NO opacity sliders.
// The redundant breadth sources (adsb.fi / OpenSky / AISStream) are hidden here and live on
// the Data sources tab. Grouping is the curated ./layerCatalog.ts; every row is wired to the
// real LayerRegistry (enable/disable) and the live useFeeds store (the status dot).
import { useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerDescriptor } from '@osint/shared';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds, feedStatusSignature, type FeedHealth, type FeedStatus } from '../state/stores.js';
import { Icon } from './Icon.js';
import {
  MAP_LAYER_FOLDERS,
  folderCounts,
  rowEnabled,
  toggleRow,
  toggleFolder,
  type CatalogFolder,
  type CatalogRow,
} from './layerCatalog.js';

export interface NormalLayerRailProps {
  registry: LayerRegistry;
  viewer: Cesium.Viewer | null;
  /** Top-bar section nav (air/maritime/space/hazards) → show just that folder. */
  filterGroup?: string | null;
}

// Section-nav id → catalog folder id (aviation→air, hazards→ground; others match).
const SECTION_TO_FOLDER: Record<string, string> = {
  aviation: 'air',
  maritime: 'maritime',
  space: 'space',
  hazards: 'ground',
};

type DotTone = 'green' | 'amber' | 'red' | 'blue' | 'off';

// Significant lowercase tokens (len ≥ 3) for loose feed↔layer matching.
function tokens(...parts: readonly string[]): readonly string[] {
  return parts
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function feedMatches(layer: LayerDescriptor, feed: FeedHealth): boolean {
  const lid = layer.id.toLowerCase();
  const fid = feed.id.toLowerCase();
  if (fid.length >= 3 && (lid.includes(fid) || fid.includes(lid))) return true;
  const ftoks = new Set(tokens(feed.id, feed.label));
  return tokens(layer.id, layer.title).some((t) => ftoks.has(t));
}

// Row status dot: best matching feed health across the row's mapped layers wins
// (green/amber/red); otherwise blue when any mapped layer is enabled, else off.
function rowTone(
  registry: LayerRegistry,
  feeds: Record<string, FeedHealth>,
  row: CatalogRow,
): DotTone {
  let matched: FeedStatus | null = null;
  for (const id of row.layerIds) {
    const layer = registry.get(id);
    if (!layer) continue;
    for (const feed of Object.values(feeds)) {
      if (!feedMatches(layer, feed)) continue;
      if (feed.status === 'green') return 'green';
      if (matched === null || feed.status !== 'unknown') matched = feed.status;
    }
  }
  if (matched === 'amber') return 'amber';
  if (matched === 'red') return 'red';
  return rowEnabled(registry, row) ? 'blue' : 'off';
}

export function NormalLayerRail(props: NormalLayerRailProps): JSX.Element {
  const { registry, filterGroup } = props;
  // Subscribe to the STATUS signature (primitive) so a feed heartbeat that only
  // updates lastSeen/note doesn't re-render the whole rail. The actual feeds map
  // is read fresh inside the tone memo below, keyed on this signature.
  const feedsSig = useFeeds((s) => feedStatusSignature(s.feeds));

  // Re-render on any registry change (enable/disable) so toggles + counts update.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const unsub = registry.subscribe(() => setTick((n) => n + 1));
    return unsub;
  }, [registry]);

  // Precompute every row's status dot ONCE per (status-change | toggle) instead
  // of O(rows×layers×feeds) on every render. Keyed on feedsSig + tick + registry.
  const tones = useMemo(() => {
    const feeds = useFeeds.getState().feeds;
    const m = new Map<string, DotTone>();
    for (const folder of MAP_LAYER_FOLDERS) {
      for (const row of folder.rows) m.set(row.label, rowTone(registry, feeds, row));
    }
    return m;
    // feedsSig is the intentional recompute key (feeds read via getState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedsSig, tick, registry]);

  const [query, setQuery] = useState('');
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});

  const q = query.trim().toLowerCase();
  const forceOpen = q.length > 0;

  const isOpen = (folder: CatalogFolder): boolean =>
    forceOpen || (openOverrides[folder.id] ?? folder.defaultOpen ?? false);
  const toggleOpen = (folder: CatalogFolder): void =>
    setOpenOverrides((prev) => ({ ...prev, [folder.id]: !isOpen(folder) }));

  // Section-nav filter + text filter → which folders/rows to show.
  const wantFolder = filterGroup ? SECTION_TO_FOLDER[filterGroup] ?? null : null;
  const folders = useMemo(() => {
    return MAP_LAYER_FOLDERS.map((folder) => {
      const rows = q.length > 0 ? folder.rows.filter((r) => r.label.toLowerCase().includes(q)) : folder.rows;
      return { folder, rows };
    }).filter(({ folder, rows }) => {
      if (wantFolder && folder.id !== wantFolder) return false;
      return rows.length > 0;
    });
  }, [q, wantFolder]);

  return (
    <div className="railbody">
      {/* Text filter — light, per the Gotham mockup (no facet controls). */}
      <div className="row" style={{ cursor: 'default', marginBottom: '0.46em' }}>
        <Icon name="search" className="ico" />
        <input
          className="nm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this map…"
          aria-label="Filter layers by name"
          style={{ background: 'transparent', border: 0, outline: 'none', color: 'inherit', font: 'inherit', width: '100%' }}
        />
      </div>

      {folders.length === 0 ? (
        <p className="note">No layers match “{query}”.</p>
      ) : (
        folders.map(({ folder, rows }) => {
          const { on, total } = folderCounts(registry, folder);
          const open = isOpen(folder);
          const anyOn = on > 0;
          return (
            <section className={open ? 'group open' : 'group'} key={folder.id}>
              <div className="folder-head" style={{ display: 'flex', alignItems: 'center', gap: '0.3em' }}>
                <button
                  type="button"
                  className="folder-expand"
                  aria-expanded={open}
                  onClick={() => toggleOpen(folder)}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.4em', border: 0, background: 'none', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit', padding: 0 }}
                >
                  <Icon name="chevron-right" className="chev" />
                  <Icon name={folder.icon} className="gicon" />
                  <span className="gname">{folder.label}</span>
                </button>
                <span className="gcount">
                  {on} / {total}
                </span>
                {/* Eye toggle — enables/disables the whole folder (Palantir visibility). */}
                <button
                  type="button"
                  className="toggle"
                  role="switch"
                  aria-checked={anyOn}
                  aria-label={`Toggle all ${folder.label} layers`}
                  onClick={() => toggleFolder(registry, folder)}
                />
              </div>
              {open && (
                <div className="group-body">
                  {rows.map((row) => {
                    const enabled = rowEnabled(registry, row);
                    const tone = tones.get(row.label) ?? 'off';
                    return (
                      <div
                        className={enabled ? 'row sel' : 'row'}
                        key={row.label}
                        onClick={() => toggleRow(registry, row)}
                      >
                        <span className={`dot ${tone}`} aria-hidden="true" />
                        <Icon name={row.icon} className="ico" />
                        <span className="nm" title={row.label}>
                          {row.label}
                        </span>
                        <button
                          type="button"
                          className="toggle"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={row.label}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(registry, row);
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
