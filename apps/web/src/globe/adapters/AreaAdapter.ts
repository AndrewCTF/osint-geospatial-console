import * as Cesium from 'cesium';
import { apiFetch } from '../../transport/http.js';
import type { AdapterCtx, LayerAdapter } from './types.js';

// Renders cross-domain incidents (the fusion brief) and internet outages (CAIDA
// IODA) as translucent coloured AREAS with a text label — orange/red by
// severity, pulsing for the most severe — instead of a bare point. This is the
// "conflict areas as areas, not dots" the operator asked for.
//
// Both feeds map onto one geometry: a ground ellipse at the centroid sized by
// the incident span (or a nominal radius for outages) + a label. Upsert by a
// STABLE composite key (centroid+domains) because the brief mints a fresh random
// `id` every poll — keying on it would churn every entity each refresh.

type AreaKind = 'incidents' | 'ioda' | 'conflict';

interface Area {
  key: string;
  lon: number;
  lat: number;
  radiusKm: number;
  color: string;
  pulse: boolean;
  label: string;
}

// Threat level → colour. high reads as red (and pulses), elevated orange, low amber.
const SEV_COLOR: Record<string, string> = {
  high: '#ef4444',
  elevated: '#f59e0b',
  low: '#fbbf24',
};

function round(n: number, p = 2): number {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

// Best-effort geocode of one IODA event. CAIDA's event geometry is not
// guaranteed — country/region/ASN events often carry no point — so we probe the
// common coordinate fields and skip (counting it) when none is present. This is
// unverified against a live CAIDA feed (the endpoint was unreachable from the
// build egress); the country-polygon upgrade is tracked in the plan.
function iodaPoint(
  it: Record<string, unknown>,
): { lon: number; lat: number; name: string; score: number } | null {
  const entity = (it.entity as Record<string, unknown>) ?? {};
  const attrs = (entity.attrs as Record<string, unknown>) ?? {};
  const geo = (it.geo as Record<string, unknown>) ?? (attrs.geo as Record<string, unknown>) ?? {};
  const num = (...vals: unknown[]): number | null => {
    for (const v of vals) {
      const n = typeof v === 'string' ? parseFloat(v) : (v as number);
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
    return null;
  };
  const lat = num(it.lat, geo.lat, geo.latitude, attrs.latitude);
  const lon = num(it.lon, it.lng, geo.lng, geo.lon, geo.longitude, attrs.longitude);
  if (lat == null || lon == null) return null;
  const name =
    (it.location_name as string) ||
    (entity.name as string) ||
    (it.location as string) ||
    'unknown';
  const score = num(it.score) ?? 0;
  return { lon, lat, name, score };
}

function buildAreas(kind: AreaKind, json: unknown): Area[] {
  const j = (json ?? {}) as Record<string, unknown>;
  if (kind === 'conflict') {
    // Real GDELT armed-conflict events (GeoJSON points). GDELT places many
    // reports at the same city/country centroid, so we MERGE by a ~11 km cell
    // (keep the strongest, sum the mentions) to stop a smear of stacked discs +
    // labels, then only LABEL the prominent ones so text stays readable.
    const feats = (j.features as Record<string, unknown>[]) ?? [];
    const cells = new Map<string, { lon: number; lat: number; ment: number; root: string; label: string }>();
    for (const f of feats) {
      const g = (f.geometry as { coordinates?: [number, number] }) ?? {};
      const c = g.coordinates;
      if (!c || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
      const p = (f.properties as Record<string, unknown>) ?? {};
      const ment = typeof p.mentions === 'number' ? p.mentions : 1;
      const root = String(p.root ?? '');
      const cellKey = `${round(c[0], 1)}|${round(c[1], 1)}`;
      const prev = cells.get(cellKey);
      if (!prev) {
        cells.set(cellKey, { lon: c[0], lat: c[1], ment, root, label: String(p.label ?? 'armed clash') });
      } else {
        prev.ment += ment;
        if (ment > 0 && String(p.label ?? '').length) {
          // keep the highest-intensity event's wording as the headline
          if (ment >= prev.ment - ment) prev.label = String(p.label);
        }
        if (root === '20') prev.root = '20';
      }
    }
    return [...cells.entries()].map(([cellKey, v]): Area => ({
      key: `conflict|${cellKey}`,
      lon: v.lon,
      lat: v.lat,
      radiusKm: Math.min(70, 14 + v.ment * 1.2),
      color: v.root === '20' ? '#dc2626' : '#ef4444',
      pulse: v.ment >= 25 || v.root === '20',
      // Only the prominent cells get a text label (keeps the map readable).
      // strip the per-event "(Nx)" the backend baked in, show the merged total.
      label: v.ment >= 6 ? `${v.label.replace(/\s*\(\d+x\)\s*$/, '')} (${v.ment}x)`.slice(0, 80) : '',
    }));
  }
  if (kind === 'incidents') {
    const incidents = (j.incidents as Record<string, unknown>[]) ?? [];
    return incidents
      .map((inc): Area | null => {
        const c = (inc.centroid as { lon?: number; lat?: number }) ?? {};
        if (typeof c.lon !== 'number' || typeof c.lat !== 'number') return null;
        const level = String(inc.threat_level ?? 'low');
        const domains = (inc.domains as string[]) ?? [];
        const narrative = String(inc.narrative ?? 'incident');
        const span = typeof inc.span_km === 'number' ? inc.span_km : 0;
        return {
          key: `${round(c.lon)}|${round(c.lat)}|${domains.join(',')}`,
          lon: c.lon,
          lat: c.lat,
          radiusKm: Math.max(span, 8),
          color: SEV_COLOR[level] ?? '#fbbf24',
          pulse: level === 'high',
          label: `${level.toUpperCase()} · ${narrative}`.slice(0, 80),
        };
      })
      .filter((a): a is Area => a != null);
  }
  // IODA outages.
  const items = (j.items as Record<string, unknown>[]) ?? [];
  return items
    .map((it): Area | null => {
      const p = iodaPoint(it);
      if (!p) return null;
      return {
        key: `ioda|${round(p.lon)}|${round(p.lat)}`,
        lon: p.lon,
        lat: p.lat,
        radiusKm: 120,
        color: p.score >= 50 ? '#ef4444' : '#f59e0b',
        pulse: p.score >= 50,
        label: `INTERNET OUTAGE · ${p.name}${p.score ? ` (${Math.round(p.score)})` : ''}`,
      };
    })
    .filter((a): a is Area => a != null);
}

export class AreaAdapter implements LayerAdapter {
  readonly ds: Cesium.CustomDataSource;
  private readonly entities = new Map<string, Cesium.Entity>();
  private timer: number | null = null;
  private renderTimer: number | null = null;
  private pulsingCount = 0;
  private disposed = false;

  constructor(
    private readonly props: {
      ctx: AdapterCtx;
      endpoint: string;
      kind: AreaKind;
      intervalSec: number;
    },
  ) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    // Drive the pulse under requestRenderMode: while ≥1 area pulses, ask for a
    // render ~3 Hz. ponytail: a coarse repaint is plenty for a slow breathe and
    // costs nothing when no high-severity area is present.
    this.renderTimer = window.setInterval(() => {
      if (this.pulsingCount > 0) viewer.scene.requestRender();
    }, 333);
    await this.poll();
    this.timer = window.setInterval(() => void this.poll(), this.props.intervalSec * 1000);
  }

  detach(): void {
    this.disposed = true;
    if (this.timer != null) window.clearInterval(this.timer);
    if (this.renderTimer != null) window.clearInterval(this.renderTimer);
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* viewer already torn down */
    }
  }

  private async poll(): Promise<void> {
    const { ctx, endpoint, kind } = this.props;
    try {
      // no-store: these are live feeds; a stale 200 (e.g. an SPA fallback cached
      // before the route existed) would otherwise pin forever.
      const r = await apiFetch(endpoint, { cache: 'no-store' });
      if (this.disposed) return;
      if (!r.ok) {
        ctx.reportStatus({ status: 'red', note: `HTTP ${r.status}` });
        return;
      }
      const json = await r.json();
      const areas = buildAreas(kind, json);
      this.render(areas);
      // For IODA, surface how many events actually carried coordinates so thin
      // geo coverage reads as thin, not as "all clear".
      const note =
        kind === 'ioda'
          ? `${((json?.items as unknown[]) ?? []).length} events, ${areas.length} located`
          : `${areas.length} areas`;
      ctx.reportStatus({ status: 'green', lastSeen: Date.now(), note });
    } catch (e) {
      if (!this.disposed) ctx.reportStatus({ status: 'red', note: String(e).slice(0, 80) });
    }
  }

  private render(areas: Area[]): void {
    const seen = new Set<string>();
    this.pulsingCount = 0;
    for (const a of areas) {
      seen.add(a.key);
      if (a.pulse) this.pulsingCount++;
      const base = Cesium.Color.fromCssColorString(a.color);
      const existing = this.entities.get(a.key);
      const radius = a.radiusKm * 1000;
      // Pulsing fill alpha for high severity; steady translucent fill otherwise.
      const fill = a.pulse
        ? new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const t = (performance.now() / 1000) * 1.6;
              return base.withAlpha(0.14 + 0.12 * (0.5 + 0.5 * Math.sin(t)));
            }, false),
          )
        : new Cesium.ColorMaterialProperty(base.withAlpha(0.18));
      if (existing) {
        existing.position = new Cesium.ConstantPositionProperty(
          Cesium.Cartesian3.fromDegrees(a.lon, a.lat),
        );
        if (existing.ellipse) {
          existing.ellipse.semiMajorAxis = new Cesium.ConstantProperty(radius);
          existing.ellipse.semiMinorAxis = new Cesium.ConstantProperty(radius);
          existing.ellipse.material = fill;
          existing.ellipse.outlineColor = new Cesium.ConstantProperty(base);
        }
        if (existing.label) existing.label.text = new Cesium.ConstantProperty(a.label);
        continue;
      }
      const opts: Cesium.Entity.ConstructorOptions = {
        id: a.key,
        position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: fill,
          outline: true,
          outlineColor: base,
          outlineWidth: 2,
          height: 0,
        },
      };
      // Only label when there is text (low-intensity conflict cells render as a
      // bare disc so the map doesn't smear).
      if (a.label) {
        opts.label = {
          text: a.label,
          font: 'bold 11px "IBM Plex Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString('#05070b'),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#05070b').withAlpha(0.7),
          pixelOffset: new Cesium.Cartesian2(0, -14),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          translucencyByDistance: new Cesium.NearFarScalar(2.0e6, 1.0, 2.0e7, 0.0),
          // Depth-tested (no disableDepthTestDistance) so the globe OCCLUDES a
          // conflict label on the far side instead of it bleeding through.
        };
      }
      const ent = this.ds.entities.add(opts);
      this.entities.set(a.key, ent);
    }
    // Drop areas that are no longer in the brief.
    for (const [key, ent] of this.entities) {
      if (!seen.has(key)) {
        this.ds.entities.remove(ent);
        this.entities.delete(key);
      }
    }
    this.props.ctx.viewer.scene.requestRender();
  }
}
