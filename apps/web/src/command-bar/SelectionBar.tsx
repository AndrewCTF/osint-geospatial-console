import { useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';
import { flyToPosition, followEntity, stopFollow, isFollowing } from '../globe/camera.js';
import { useProjection } from '../globe/ProjectionLayer.js';
import { useChip } from '../imagery/chipStore.js';
import { useInvestigation } from '../graph/investigationStore.js';
import { usePolReplay } from '../state/polReplayStore.js';
import { useAnnotations } from '../annotations/annotationStore.js';
import { apiFetch } from '../transport/http.js';
import { MicroLabel } from '../shell/instruments.js';

// Contextual selection toolbar (Gotham action-ribbon idiom). Appears centred at
// the top of the globe only when a map entity is selected, with the per-entity
// verbs grouped into SELECT / ANNOTATE / OPS clusters. Every button drives the
// SAME wired action the EntityPanel uses — nothing here is decorative.
//
// Situations are aggregate case files with their own panel, so the bar suppresses
// itself for `situation:` selections.

interface Sel {
  position: { lon: number; lat: number; alt: number } | null;
  props: Record<string, unknown>;
  name: string | undefined;
  kind: string | undefined;
}

export function SelectionBar({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  const id = useSelection((s) => s.selectedEntityId);
  // Bump to re-read follow state after a toggle (Cesium owns it, not a store).
  const [, setTick] = useState(0);

  if (!viewer || !id || id.startsWith('situation:')) return null;
  const sel = readSel(viewer, id);
  if (!sel) return null;
  const pos = sel.position;
  const label = (sel.name || (sel.kind ? `${sel.kind} ${id}` : id)).slice(0, 120);
  const following = isFollowing(viewer, id);
  const moving = sel.kind === 'vessel' || sel.kind === 'aircraft';

  return (
    <div
      className="pointer-events-auto flex flex-col w-[150px] rounded-sm border border-line-2 bg-bg-1/92 backdrop-blur-sm overflow-hidden"
      role="toolbar"
      aria-label="Selection actions"
      style={{ boxShadow: '0 2px 10px -4px rgba(0,0,0,0.7)' }}
    >
      <Group label="Select">
        <BarBtn label="→ Slew" title="Fly the camera to this entity"
          disabled={!pos}
          onClick={() => pos && flyToPosition(viewer, pos.lon, pos.lat, 350_000, 1.0)} />
        <BarBtn label={following ? '◼ Following' : '⌖ Follow'} title="Lock the camera to this entity"
          active={following}
          onClick={() => {
            if (following) stopFollow(viewer);
            else followEntity(viewer, id);
            setTick((n) => n + 1);
          }} />
        <BarBtn label="✕ Clear" title="Deselect"
          onClick={() => useSelection.getState().select(null)} />
      </Group>

      <Group label="Annotate">
        <BarActionBtn label="⚑ Flag" done="Flagged" title="Flag this entity (audited)"
          action="flag_entity" params={{ target_id: id, note: '', severity: 3 }} />
        <BarBtn label="✎ Mark" title="Drop a point annotation at this entity"
          disabled={!pos}
          onClick={() => pos && useAnnotations.getState().add({
            kind: 'point', label, threat: 'unknown', coords: [[pos.lon, pos.lat]],
          })} />
        <BarActionBtn label="⌂ Watch" done="Watching" title="Watch a 50 nm radius here (audited)"
          disabled={!pos}
          action="add_watch"
          params={pos ? { target_id: id, label, lat: pos.lat, lon: pos.lon, radius_nm: 50 } : {}} />
      </Group>

      <Group label="Ops" last>
        <BarActionBtn label="◎ Target" done="Nominated" title="Nominate as a target (audited)"
          action="nominate_target" params={{ target_id: id, priority: 3, note: '' }} />
        <BarBtn label="⊹ Around" title="Open the link-analysis graph around this entity"
          onClick={() => useInvestigation.getState().searchAround(id)} />
        <BarBtn label="⟲ Pattern" title="Replay this entity's pattern of life"
          onClick={() => usePolReplay.getState().play(id)} />
        {moving && (
          <BarBtn label="⤳ Project" title="Project the +1/3/6h reachable area"
            disabled={!pos}
            onClick={() => {
              if (!pos) return;
              const proj = useProjection.getState();
              if (proj.show && proj.entityId === id) { proj.clear(); return; }
              proj.project({ entityId: id, lat: pos.lat, lon: pos.lon, ...speedCog(sel.props) });
            }} />
        )}
        <BarBtn label="⊞ Imagery" title="Drape a dated satellite chip here"
          disabled={!pos}
          onClick={() => pos && useChip.getState().setFocus({ entityId: id, lat: pos.lat, lon: pos.lon, radiusKm: 4 })} />
      </Group>
    </div>
  );
}

// ── grouped cluster: a labelled stack of full-width buttons with a divider ──
function Group({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }): JSX.Element {
  return (
    <div className={`flex flex-col gap-1 px-2 py-1.5 ${last ? '' : 'border-b border-line'}`}>
      <MicroLabel className="text-[8px]">{label}</MicroLabel>
      {children}
    </div>
  );
}

// Plain action button — fires onClick immediately (camera / store verbs).
function BarBtn({
  label, title, onClick, active = false, disabled = false,
}: {
  label: string; title: string; onClick: () => void; active?: boolean; disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'mono text-[9.5px] tracking-[0.3px] w-full text-left px-2 py-1.5 border rounded-sm transition-colors whitespace-nowrap disabled:opacity-30',
        active
          ? 'border-accent-line text-accent bg-accent-dim'
          : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

// Governed write-back button — POSTs to /api/actions/{action} and shows a
// transient ✓/✗ (mirrors the EntityPanel ActionButton, compact for the bar).
type Phase = 'idle' | 'running' | 'ok' | 'error';
function BarActionBtn({
  label, done, title, action, params, disabled = false,
}: {
  label: string;
  done: string;
  title: string;
  action: 'flag_entity' | 'nominate_target' | 'add_watch';
  params: Record<string, unknown>;
  disabled?: boolean;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const run = async (): Promise<void> => {
    setPhase('running');
    try {
      const r = await apiFetch(`/api/actions/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      setPhase(r.ok ? 'ok' : 'error');
    } catch {
      setPhase('error');
    }
    window.setTimeout(() => setPhase('idle'), 2200);
  };
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={disabled || phase === 'running'}
      title={title}
      className={[
        'mono text-[9.5px] tracking-[0.3px] w-full text-left px-2 py-1.5 border rounded-sm transition-colors whitespace-nowrap disabled:opacity-30',
        phase === 'ok'
          ? 'border-[rgba(54,211,153,0.5)] text-ok'
          : phase === 'error'
            ? 'border-[rgba(255,90,82,0.5)] text-alert'
            : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1',
      ].join(' ')}
    >
      {phase === 'running' ? '…' : phase === 'ok' ? `✓ ${done}` : phase === 'error' ? '✗ failed' : label}
    </button>
  );
}

// Speed (kn) + course for the reach projection — vessels report knots (sog),
// aircraft m/s (velocity_ms → kn). Same derivation as the EntityPanel button.
function speedCog(p: Record<string, unknown>): { speedKn: number; cog: number | null } {
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return 0;
  };
  let speedKn = num('sog', 'speed_kn', 'gs', 'speed');
  const vms = num('velocity_ms');
  if (!speedKn && vms) speedKn = vms * 1.94384;
  const cog = num('cog', 'track_deg', 'track', 'heading');
  return { speedKn, cog: cog || null };
}

// ponytail: lightweight local entity read (props + position) — the EntityPanel
// has equivalents inline; extract a shared util if a third consumer appears.
function readSel(viewer: Cesium.Viewer, id: string): Sel | null {
  if (viewer.isDestroyed()) return null;
  let e: Cesium.Entity | undefined;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    e = viewer.dataSources.get(i).entities.getById(id);
    if (e) break;
  }
  if (!e) e = viewer.entities.getById(id);
  if (!e) return null;

  const props: Record<string, unknown> = {};
  const bag = e.properties;
  const names = (bag?.propertyNames as readonly string[] | undefined) ?? [];
  const t = Cesium.JulianDate.now();
  for (const n of names) {
    const prop = (bag as unknown as Record<string, Cesium.Property | undefined>)[n];
    if (!prop) continue;
    try {
      props[n] = prop.getValue(t);
    } catch {
      /* skip */
    }
  }

  let position: Sel['position'] = null;
  if (e.position) {
    const cart = e.position.getValue(viewer.clock.currentTime);
    if (cart) {
      const c = Cesium.Cartographic.fromCartesian(cart);
      position = {
        lon: Cesium.Math.toDegrees(c.longitude),
        lat: Cesium.Math.toDegrees(c.latitude),
        alt: c.height,
      };
    }
  }
  return { position, props, name: e.name, kind: props['kind'] ? String(props['kind']) : undefined };
}
