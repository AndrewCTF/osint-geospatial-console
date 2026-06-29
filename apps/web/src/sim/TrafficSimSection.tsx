// Traffic-sim section: picks the nearest public cam to a point, runs the desktop
// CUDA sidecar on its snapshot in a poll loop, and seeds TrafficController with
// the detected vehicle count (animated vehicles on the globe). Desktop-only —
// the website shows a caveat. Shared by the Ground Recon panel (point = AOI) and
// the Traffic sim right-rail tab (point = map centre).
import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { Widget, KV, KVRow, MicroLabel, Caveat, Btn } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';
import { detectImage, detectStatus, isDesktop } from '../transport/desktop.js';
import { TrafficController, type CamInfo } from './TrafficController.js';
import type { DetectStatus } from '../ground/types.js';
import type { LatLon } from '../globe/center.js';

export function TrafficSimSection({
  viewer,
  center,
}: {
  viewer: Cesium.Viewer | null;
  center: LatLon | null;
}): JSX.Element {
  const [cam, setCam] = useState<CamInfo | null>(null);
  const [simCount, setSimCount] = useState<number | null>(null);
  const [status, setStatus] = useState<DetectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tcRef = useRef<TrafficController | null>(null);
  const loopRef = useRef<number | null>(null);
  const desktop = isDesktop();

  // Find the nearest cam to the point whenever it changes.
  useEffect(() => {
    setCam(null);
    setSimCount(null);
    if (!center) return;
    let cancelled = false;
    apiFetch('/api/cams')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`cams ${r.status}`))))
      .then((fc: { features?: Array<Record<string, unknown>> }) => {
        if (cancelled) return;
        let best: CamInfo | null = null;
        let bestD = Infinity;
        for (const f of fc.features ?? []) {
          const p = (f.properties ?? {}) as Record<string, unknown>;
          const coords = (f.geometry as { coordinates?: [number, number, number] } | undefined)?.coordinates;
          if (!coords || !p.cam_id) continue;
          const lat = coords[1];
          const lon = coords[0];
          const d = Math.hypot(lat - center.lat, lon - center.lon);
          if (d < bestD) {
            bestD = d;
            best = { cam_id: String(p.cam_id), name: String(p.name ?? p.cam_id), lat, lon };
          }
        }
        if (best && bestD < 1.0) setCam(best); // within ~1° (~111 km) of the point
      })
      .catch(() => {
        /* cams unavailable — section just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [center]);

  useEffect(() => {
    if (desktop) void detectStatus().then(setStatus);
  }, [desktop]);

  // Tear down the controller + poll loop on unmount.
  useEffect(() => {
    return () => {
      if (loopRef.current) window.clearInterval(loopRef.current);
      tcRef.current?.dispose();
      tcRef.current = null;
    };
  }, []);

  const runOnce = async (c: CamInfo): Promise<void> => {
    const tc = tcRef.current;
    if (!tc) return;
    try {
      const r = await apiFetch(`/api/cams/${encodeURIComponent(c.cam_id)}/snapshot`);
      if (!r.ok) throw new Error(`snap ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const dets = await detectImage(bytes);
      const res = await tc.seed(c, dets ?? []);
      setSimCount(res.count);
      setMsg(res.road ? null : 'no road geometry — using fallback line');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'sim failed');
    }
  };

  const onSimulate = async (): Promise<void> => {
    if (!viewer || !cam || busy) return;
    setBusy(true);
    if (!tcRef.current) tcRef.current = new TrafficController(viewer);
    await runOnce(cam);
    // Re-detect + re-seed every 10 s so the count tracks the live feed.
    if (loopRef.current) window.clearInterval(loopRef.current);
    loopRef.current = window.setInterval(() => {
      void runOnce(cam);
    }, 10_000);
    setBusy(false);
  };

  const onStop = (): void => {
    if (loopRef.current) {
      window.clearInterval(loopRef.current);
      loopRef.current = null;
    }
    tcRef.current?.stop();
    setSimCount(null);
  };

  if (!desktop) {
    return (
      <div className="border border-line rounded-sm bg-bg-1/60 p-2">
        <Caveat level="DESKTOP-ONLY" tone="warn" />
        <MicroLabel>cam → CUDA detect → animated traffic runs in the desktop app</MicroLabel>
      </div>
    );
  }

  return (
    <Widget title="Traffic sim" count={simCount != null ? `${simCount} veh` : status ? status.device : '—'}>
      {cam ? (
        <KV>
          <KVRow k="Cam" v={cam.name} />
          <KVRow k="Detect" v={status ? `${status.device}${status.ready ? '' : ' (warming)'}` : '—'} />
          <KVRow k="Sim" v={simCount != null ? `${simCount} vehicles` : 'idle'} />
        </KV>
      ) : (
        <MicroLabel>{center ? 'no public cam near this point' : 'set a location'}</MicroLabel>
      )}
      {msg && <span className="mono text-[9px] text-alert">{msg}</span>}
      <div className="mt-2 flex gap-1.5">
        <Btn size="sm" tone="accent" onClick={() => void onSimulate()} disabled={!cam || busy || !viewer}>
          {busy ? 'starting…' : '▶ simulate'}
        </Btn>
        <Btn size="sm" onClick={onStop} disabled={simCount == null}>
          stop
        </Btn>
      </div>
    </Widget>
  );
}
