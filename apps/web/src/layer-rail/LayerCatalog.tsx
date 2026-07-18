import { useEffect, useReducer, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { Icon } from '../normal/Icon.js';
import {
  MAP_LAYER_FOLDERS,
  rowEnabled,
  toggleRow,
  folderCounts,
  toggleFolder,
  type CatalogFolder,
} from '../normal/layerCatalog.js';

// Curated layer catalog (design §6.2 salvage) — the 34-source registry grouped
// into a small set of plain-English capability FOLDERS/ROWS, the default Layers
// flyout. A clean Tailwind rebuild of the old .nrm-coupled NormalLayerRail using
// the same pure `layerCatalog.ts` data. "All sources" (raw registry LayerRail) is
// a separate rail entry for the advanced view.
//
// Per-folder accent hue, echoing the globe category palette (styles.ts) so the
// rail reads the same colour language as the map: aircraft-yellow, vessel-teal,
// satellite-violet, hazard-amber, etc. Drives the folder icon + every enabled
// row's accents so you can tell categories apart by colour, not just position.
const FOLDER_COLOR: Record<string, string> = {
  air: '#facc15', // airliner yellow
  maritime: '#2dd4bf', // vessel teal
  space: '#a78bfa', // satellite violet
  ground: '#f59e0b', // hazard amber
  signals: '#f472b6', // signals/events pink
  infra: '#60a5fa', // infrastructure blue
  reference: '#94a3b8', // reference slate
};

// ponytail: registry.subscribe → forceUpdate on toggle; no local mirror of state.
export function LayerCatalog({ registry }: { registry: LayerRegistry; viewer?: Cesium.Viewer | null }): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => registry.subscribe(force), [registry]);

  return (
    <div className="p-2 flex flex-col gap-2">
      {MAP_LAYER_FOLDERS.map((folder) => (
        <Folder key={folder.id} folder={folder} registry={registry} />
      ))}
    </div>
  );
}

function Folder({ folder, registry }: { folder: CatalogFolder; registry: LayerRegistry }): JSX.Element {
  const [open, setOpen] = useState(folder.defaultOpen ?? false);
  const { on, total } = folderCounts(registry, folder);
  const color = FOLDER_COLOR[folder.id] ?? 'var(--accent)';
  return (
    <div className="rounded-sm border border-line/60 overflow-hidden">
      {/* Coloured left edge ties the whole folder to its category hue. */}
      <div className="flex items-center gap-1.5 px-2 h-9 bg-bg-1 border-l-[3px]" style={{ borderLeftColor: color }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-txt-1 hover:text-txt-0"
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} className="w-3 h-3 shrink-0 text-txt-3" />
          <span className="shrink-0 flex" style={{ color }}>
            <Icon name={folder.icon} className="w-4 h-4" />
          </span>
          <span className="font-label font-semibold uppercase tracking-[0.8px] text-[13px] truncate">{folder.label}</span>
        </button>
        <span
          className="mono text-[10px] tabular-nums"
          style={{ color: on > 0 ? color : 'var(--txt-3)' }}
        >
          {on}/{total}
        </span>
        <button
          type="button"
          onClick={() => toggleFolder(registry, folder)}
          title={on > 0 ? 'Turn all off' : 'Turn all on'}
          className="w-5 h-5 flex items-center justify-center rounded-sm border transition-colors"
          style={
            on > 0
              ? { color, borderColor: color, background: `${color}22` }
              : undefined
          }
        >
          <Icon name="crosshair" className={`w-3 h-3 ${on > 0 ? '' : 'text-txt-3'}`} />
        </button>
      </div>
      {open && (
        <div className="bg-bg-0/40">
          {folder.rows.map((row) => {
            const en = rowEnabled(registry, row);
            return (
              <button
                key={row.label}
                type="button"
                onClick={() => toggleRow(registry, row)}
                className={`flex items-center gap-2 w-full px-2.5 py-2 text-left border-t border-line/50 border-l-2 transition-[filter] ${
                  en ? 'hover:brightness-125' : 'border-l-transparent hover:bg-bg-2'
                }`}
                style={en ? { borderLeftColor: color, background: `${color}1f` } : undefined}
                aria-pressed={en}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${en ? '' : 'bg-txt-4'}`}
                  style={en ? { background: color, boxShadow: `0 0 6px ${color}` } : undefined}
                />
                <span className={`shrink-0 flex ${en ? '' : 'text-txt-3'}`} style={en ? { color } : undefined}>
                  <Icon name={row.icon} className="w-4 h-4" />
                </span>
                <span className={`text-[12px] flex-1 truncate ${en ? 'text-txt-0 font-medium' : 'text-txt-2'}`}>
                  {row.label}
                </span>
                {en ? (
                  <span
                    className="mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-[1px] rounded-sm border shrink-0"
                    style={{ color, borderColor: color, background: `${color}22` }}
                  >
                    on
                  </span>
                ) : (
                  <span className="mono text-[10px] uppercase tracking-[0.4px] text-txt-4 shrink-0">off</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
