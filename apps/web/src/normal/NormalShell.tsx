// NormalShell — the "Normal dashboard" layout shell: a clean, approachable
// Palantir-Gotham console that lives ALONGSIDE the dense "Professional" shell.
// It owns ONLY layout + chrome geometry: a four-row CSS grid
// (classification banner / topbar / body / footer) with a resizable left and
// right rail flanking the globe. All look-and-feel lives in ./normal.css under
// the `.nrm` root scope; this file emits the structure + the resize behaviour.
//
// The globe area stays UNSCALED — `--ui-scale` is a chrome-readability
// multiplier applied to the rails/topbar font-size only, never to the Cesium
// canvas (which must stay crisp). See ./useViewportScale.ts.
import './normal.css';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useViewportScale } from './useViewportScale.js';

export interface NormalShellProps {
  top: ReactNode;
  globe: ReactNode;
  left: ReactNode;
  right: ReactNode;
  bottom: ReactNode;
  /** Banner text. */
  classification?: string;
  /** When true, render the amber EXERCISE banner variant. */
  exercise?: boolean;
}

const DEFAULT_CLASSIFICATION = 'Unclassified // Open-source intelligence';

// localStorage keys for operator-resized rail widths.
const LEFT_KEY = 'nrm.leftW';
const RIGHT_KEY = 'nrm.rightW';

// Resize clamp bounds (px). Left rail is allowed 220..560; right rail 260..620.
// Below the min the rail content (grouped layer rows / dossier widgets) starts
// to wrap badly; above the max the map gets squeezed on a 1280px laptop.
const LEFT_MIN = 220;
const LEFT_MAX = 560;
const RIGHT_MIN = 260;
const RIGHT_MAX = 620;

// Keyboard nudge step for the separators (px per arrow press).
const KEY_STEP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Read a persisted width, or null when absent/invalid (so we fall back to the
 *  viewport default and keep re-applying it until the operator drags). */
function readStored(key: string): number | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(key);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function persist(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, String(Math.round(value)));
}

interface DragSession {
  side: 'l' | 'r';
  startX: number;
  startW: number;
}

export function NormalShell(props: NormalShellProps): JSX.Element {
  const {
    top,
    globe,
    left,
    right,
    bottom,
    classification = DEFAULT_CLASSIFICATION,
    exercise = false,
  } = props;

  const vp = useViewportScale();

  // Rail widths: initialise from localStorage, else the viewport default.
  const [leftW, setLeftW] = useState<number>(() => {
    const stored = readStored(LEFT_KEY);
    return stored != null ? clamp(stored, LEFT_MIN, LEFT_MAX) : vp.leftW;
  });
  const [rightW, setRightW] = useState<number>(() => {
    const stored = readStored(RIGHT_KEY);
    return stored != null ? clamp(stored, RIGHT_MIN, RIGHT_MAX) : vp.rightW;
  });

  // Re-apply the viewport default ONLY while the operator has not stored a
  // width — once they drag (which persists), their choice wins across tiers.
  useEffect(() => {
    if (readStored(LEFT_KEY) == null) setLeftW(vp.leftW);
  }, [vp.leftW]);
  useEffect(() => {
    if (readStored(RIGHT_KEY) == null) setRightW(vp.rightW);
  }, [vp.rightW]);

  const dragRef = useRef<DragSession | null>(null);

  // Global pointer listeners: live-update the dragged rail and persist as we go
  // (persisting on every move also marks the width "stored", so the default
  // re-apply effect above stops fighting the operator immediately).
  useEffect(() => {
    function onMove(e: PointerEvent): void {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (d.side === 'l') {
        // Left rail resizer sits on the rail's RIGHT (inner) edge: drag right → wider.
        const next = clamp(d.startW + dx, LEFT_MIN, LEFT_MAX);
        setLeftW(next);
        persist(LEFT_KEY, next);
      } else {
        // Right rail resizer sits on the rail's LEFT (inner) edge: drag left → wider.
        const next = clamp(d.startW - dx, RIGHT_MIN, RIGHT_MAX);
        setRightW(next);
        persist(RIGHT_KEY, next);
      }
    }
    function onUp(): void {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const startDrag = useCallback(
    (side: 'l' | 'r') => (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      dragRef.current = { side, startX: e.clientX, startW: side === 'l' ? leftW : rightW };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [leftW, rightW],
  );

  // Keyboard resize for accessibility: arrow keys nudge the focused separator.
  const onResizerKey = useCallback(
    (side: 'l' | 'r') => (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = -KEY_STEP;
      else if (e.key === 'ArrowRight') delta = KEY_STEP;
      else return;
      e.preventDefault();
      if (side === 'l') {
        // Right edge: ArrowRight grows the left rail.
        const next = clamp(leftW + delta, LEFT_MIN, LEFT_MAX);
        setLeftW(next);
        persist(LEFT_KEY, next);
      } else {
        // Left edge: ArrowLeft grows the right rail (so invert the delta).
        const next = clamp(rightW - delta, RIGHT_MIN, RIGHT_MAX);
        setRightW(next);
        persist(RIGHT_KEY, next);
      }
    },
    [leftW, rightW],
  );

  // Root grid: [banner 20px][topbar auto][body 1fr][footer footerH]. `--ui-scale`
  // drives chrome readability only. Cast through unknown because @types/react 18
  // has no custom-property index signature on CSSProperties.
  const rootStyle = {
    display: 'grid',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    gridTemplateRows: `20px auto 1fr ${vp.footerH}px`,
    '--ui-scale': vp.scale,
  } as unknown as CSSProperties;

  const bodyStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `${leftW}px 1fr ${rightW}px`,
    minHeight: 0,
    overflow: 'hidden',
  };

  const centerStyle: CSSProperties = { position: 'relative', overflow: 'hidden', minWidth: 0 };
  const globeFillStyle: CSSProperties = { position: 'absolute', inset: 0 };

  return (
    <div className="nrm" style={rootStyle}>
      <a className="skip" href="#nrm-main">
        Skip to map
      </a>

      {/* Row 1 — classification banner */}
      <div className={exercise ? 'clsbanner exercise' : 'clsbanner'} role="status">
        <span className="pulse" aria-hidden="true" />
        {exercise ? `EXERCISE // ${classification}` : classification}
      </div>

      {/* Row 2 — top command bar */}
      <header className="topbar">{top}</header>

      {/* Row 3 — body: left rail · globe · right rail */}
      <main id="nrm-main" tabIndex={-1} style={bodyStyle}>
        <aside className="rail l" aria-label="Layers and feeds">
          {left}
          <div
            className="resizer e"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize layers panel"
            aria-valuenow={Math.round(leftW)}
            aria-valuemin={LEFT_MIN}
            aria-valuemax={LEFT_MAX}
            tabIndex={0}
            title="Drag or use arrow keys to resize"
            onPointerDown={startDrag('l')}
            onKeyDown={onResizerKey('l')}
          >
            <span className="grip" aria-hidden="true" />
          </div>
        </aside>

        <section style={centerStyle} aria-label="Map">
          <div style={globeFillStyle}>{globe}</div>
        </section>

        <aside className="rail r" aria-label="Selection and intel">
          <div
            className="resizer w"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize selection panel"
            aria-valuenow={Math.round(rightW)}
            aria-valuemin={RIGHT_MIN}
            aria-valuemax={RIGHT_MAX}
            tabIndex={0}
            title="Drag or use arrow keys to resize"
            onPointerDown={startDrag('r')}
            onKeyDown={onResizerKey('r')}
          >
            <span className="grip" aria-hidden="true" />
          </div>
          {right}
        </aside>
      </main>

      {/* Row 4 — timeline footer */}
      <footer className="timeline" style={{ height: vp.footerH }}>
        {bottom}
      </footer>
    </div>
  );
}
