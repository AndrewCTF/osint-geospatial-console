// NormalSelection — the clean "Selection dossier" right rail for the Normal
// dashboard, matching the gotham-mock design (selhead + Telemetry widget +
// attribute grid). All styling composes the `.nrm`-scoped classes in
// normal/normal.css and the shared <Icon/>; no new CSS, no inline colours.
//
// Data is REAL: the selected entity id comes from the selection store, and the
// telemetry is read straight off the live Cesium entity (the same upsert-by-id
// billboards the globe draws). The findEntity / readProperties / readPosition
// helpers are ported verbatim from entity-panel/EntityPanel.tsx so we resolve
// exactly what the heavy panel does — without importing any of its cards.
import { useEffect, useState, type ReactNode } from 'react';
import * as Cesium from 'cesium';
import { Icon, type IconName } from './Icon.js';
import { useSelection } from '../state/stores.js';

export interface NormalSelectionProps {
  viewer?: Cesium.Viewer | null;
}

interface SelSnapshot {
  id: string;
  name?: string;
  kind?: string;
  position?: { lon: number; lat: number; alt: number };
  properties: Record<string, unknown>;
}

export function NormalSelection(props: NormalSelectionProps): JSX.Element {
  const { viewer } = props;
  const id = useSelection((s) => s.selectedEntityId);
  const [snap, setSnap] = useState<SelSnapshot | null>(null);

  // Snapshot the selected entity once per second so the telemetry updates in
  // place. Guard a destroyed viewer (HMR / globe ErrorBoundary throws on
  // .dataSources) and clear the snapshot when the id can no longer be resolved.
  useEffect(() => {
    setSnap(null);
    if (!viewer || !id) return;
    const tick = (): void => {
      if (viewer.isDestroyed()) return;
      const e = findEntity(viewer, id);
      if (!e) {
        setSnap(null);
        return;
      }
      const properties = readProperties(e);
      const position = readPosition(e, viewer);
      const next: SelSnapshot = { id, properties };
      if (e.name) next.name = e.name;
      if (typeof properties['kind'] === 'string') next.kind = properties['kind'];
      if (position) next.position = position;
      setSnap(next);
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [id, viewer]);

  // Empty state: nothing selected, or the id no longer resolves to an entity.
  if (!id || !snap) {
    return (
      <div className="selhead col center gap8">
        <Icon name="crosshair" className="ic-20 dim" />
        <div>No entity selected</div>
        <div className="muted">Click an aircraft or vessel on the globe.</div>
      </div>
    );
  }

  const p = snap.properties;
  const name =
    strOf(p, ['callsign', 'flight']) ??
    strOf(p, ['registration', 'reg']) ??
    snap.name ??
    snap.id;
  const idLine = identityLine(p, snap.id);

  // ── telemetry cells (defensive: unknown → "—") ─────────────────────────────
  const alt = numOf(p, ['alt', 'altitude', 'baro_alt']);
  const gsKn = groundSpeedKn(p);
  const heading = numOf(p, ['track_deg', 'heading', 'cog']);
  const squawk = strOf(p, ['squawk']);
  const vrate = numOf(p, ['vert_rate', 'baro_rate']);
  const type = strOf(p, ['type']) ?? snap.kind ?? null;
  const pos = snap.position;

  return (
    <div>
      <div className="selhead">
        <div className="id">{idLine}</div>
        <h2>
          <Icon name={categoryIcon(snap.kind, p)} />
          {name}
        </h2>
        <div className="sub">
          {snap.kind ? <span className="chip">{snap.kind}</span> : null}
          <span className="chip live">
            <span className="dot green" />
            Live
          </span>
        </div>
      </div>

      <div className="railbody">
        <div className="widget">
          <div className="wh">
            <Icon name="gauge" />
            <span className="wt">Telemetry</span>
            <span className="wc">live</span>
          </div>
          <div className="wb">
            <div className="attr">
              <Cell label="Altitude" value={alt != null ? withUnit(round(alt), 'ft') : DASH} />
              <Cell label="Ground speed" value={gsKn != null ? withUnit(round(gsKn), 'kn') : DASH} />
              <Cell label="Heading" value={heading != null ? `${pad3(heading)}°` : DASH} />
              {squawk != null ? (
                <Cell label="Squawk" value={squawk} />
              ) : (
                <Cell label="Vert rate" value={vrate != null ? signed(vrate) : DASH} />
              )}
              <Cell
                label="Position"
                value={pos ? `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` : DASH}
                sans
              />
              <Cell label="Type" value={type ?? DASH} sans />
            </div>
          </div>
        </div>

        <p className="note">
          Live values refresh each second from the selected track. Fields the
          feed does not broadcast show &ldquo;{DASH}&rdquo;.
        </p>
      </div>
    </div>
  );
}

// ── small presentational helpers ─────────────────────────────────────────────

const DASH = '—'; // em-dash placeholder for unknown values

/** One attribute cell in the 2-col telemetry grid. */
function Cell({
  label,
  value,
  sans = false,
}: {
  label: string;
  value: ReactNode;
  sans?: boolean;
}): JSX.Element {
  return (
    <div>
      <div className="k">{label}</div>
      <div className={sans ? 'v s' : 'v'}>{value}</div>
    </div>
  );
}

/** Numeric value with a small trailing unit, matching the mockup ("34,000 ft"). */
function withUnit(value: string, unit: string): JSX.Element {
  return (
    <>
      {value}
      <small> {unit}</small>
    </>
  );
}

/** Category glyph for the header — jet / heli / plane / ship by kind. */
function categoryIcon(kind: string | undefined, p: Record<string, unknown>): IconName {
  if (kind === 'vessel') return 'ship';
  if (kind === 'aircraft') {
    const tag = `${strOf(p, ['category', 'type']) ?? ''}`.toLowerCase();
    if (tag.includes('heli') || tag.includes('rotor')) return 'heli';
    if (p['military'] === true) return 'jet';
    return 'plane';
  }
  return 'crosshair';
}

/** Build the mono id line: domain id (ICAO24 / MMSI) · source. */
function identityLine(p: Record<string, unknown>, fallback: string): string {
  const parts: string[] = [];
  const icao = strOf(p, ['icao24']);
  if (icao) parts.push(`ICAO24 · ${icao.toUpperCase()}`);
  const mmsi = strOf(p, ['mmsi']);
  if (mmsi) parts.push(`MMSI · ${mmsi}`);
  const source = strOf(p, ['source']);
  if (source) parts.push(source);
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

// ── value extraction (defensive) ─────────────────────────────────────────────

function numOf(p: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function strOf(p: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Ground speed in knots: gs/sog are already kn; velocity_ms is m/s → kn. */
function groundSpeedKn(p: Record<string, unknown>): number | null {
  const kn = numOf(p, ['gs', 'sog']);
  if (kn != null) return kn;
  const ms = numOf(p, ['velocity_ms', 'velocity']);
  if (ms != null) return ms * 1.94384;
  return null;
}

function round(n: number): string {
  return Math.round(n).toLocaleString();
}

function pad3(n: number): string {
  return String(((Math.round(n) % 360) + 360) % 360).padStart(3, '0');
}

function signed(n: number): string {
  const r = Math.round(n);
  return `${r > 0 ? '+' : ''}${r.toLocaleString()}`;
}

// ── Cesium entity helpers (ported verbatim from EntityPanel.tsx) ──────────────

function findEntity(viewer: Cesium.Viewer, id: string): Cesium.Entity | undefined {
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const ds = viewer.dataSources.get(i);
    const e = ds.entities.getById(id);
    if (e) return e;
  }
  return viewer.entities.getById(id);
}

function readProperties(e: Cesium.Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = e.properties;
  if (!props) return out;
  const names = props.propertyNames as readonly string[] | undefined;
  if (!names) return out;
  const now = Cesium.JulianDate.now();
  for (const n of names) {
    const prop = (props as unknown as Record<string, Cesium.Property | undefined>)[n];
    if (!prop) continue;
    try {
      out[n] = prop.getValue(now);
    } catch {
      /* skip unreadable property */
    }
  }
  return out;
}

function readPosition(
  e: Cesium.Entity,
  viewer: Cesium.Viewer,
): { lon: number; lat: number; alt: number } | undefined {
  if (!e.position) return undefined;
  const t = viewer.clock.currentTime;
  const cart = e.position.getValue(t);
  if (!cart) return undefined;
  const c = Cesium.Cartographic.fromCartesian(cart);
  return {
    lon: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
    alt: c.height,
  };
}
