// Normal-dashboard top command bar. The approachable Palantir-Gotham layout's
// header: brand, primary section nav, omnibar trigger, and a right cluster with
// a live-feed pill, a Zulu clock, entity counts, settings, and a user menu that
// flips the shell back to the dense "Professional" dashboard.
//
// All visual styling lives in normal/normal.css under the `.nrm` root scope —
// this file only composes those classes and the shared <Icon/>. No hardcoded
// colors: the feed dot uses the design tokens (--ok / --warn) inline.
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.js';
import { useFeeds } from '../state/stores.js';
import { useDashboardMode } from '../state/dashboardMode.js';
import { useTheme } from '../state/theme.js';

export interface NormalSection {
  id: string;
  label: string;
  icon: IconName;
}

export interface NormalTopBarProps {
  sections: NormalSection[];
  activeSection: string;
  onSection: (id: string) => void;
  onOpenSearch: () => void; // opens the omnibar / command palette
  onOpenSettings: () => void; // opens the settings modal
  aircraftCount?: number;
  vesselCount?: number;
}

/** Pad a number to two digits for the Zulu clock. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format an epoch (ms) as UTC `HH:MM:SSZ`. */
function fmtZulu(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

/** Thousands-grouped count, locale-stable for SSR/test parity. */
function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function NormalTopBar(props: NormalTopBarProps): JSX.Element {
  const { sections, activeSection, onSection, onOpenSearch, onOpenSettings, aircraftCount, vesselCount } =
    props;

  // Live wall-clock tick (1 s) so the Zulu readout always advances, independent
  // of the simulation/playback clock (which can be paused).
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Feed health → "FEEDS g/total" + a green/amber dot.
  const feeds = useFeeds((s) => s.feeds);
  const feedList = Object.values(feeds);
  const totalFeeds = feedList.length;
  const greenFeeds = feedList.filter((f) => f.status === 'green').length;
  const allGreen = totalFeeds > 0 && greenFeeds === totalFeeds;

  // Dashboard mode → user menu header + the switch action.
  const mode = useDashboardMode((s) => s.mode);
  const setMode = useDashboardMode((s) => s.setMode);
  const modeLabel = mode === 'normal' ? 'Normal dashboard' : 'Professional dashboard';

  // Light / dark theme toggle (right cluster).
  const theme = useTheme((s) => s.mode);
  const toggleTheme = useTheme((s) => s.toggle);

  // User menu open/close, with outside-click + Escape dismissal.
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const switchToProfessional = (): void => {
    setMode('professional');
    setMenuOpen(false);
  };

  const openSettingsFromMenu = (): void => {
    setMenuOpen(false);
    onOpenSettings();
  };

  return (
    <header className="topbar">
      <div className="brand">
        <Icon name="hexagon" className="logo" />
        <b>VELOCITY</b>
        <span>v0.9</span>
      </div>

      <nav className="nav" aria-label="Primary">
        {sections.map((s) => {
          const active = s.id === activeSection;
          return (
            <button
              key={s.id}
              type="button"
              className={active ? 'on' : undefined}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSection(s.id)}
            >
              <Icon name={s.icon} />
              {s.label}
            </button>
          );
        })}
      </nav>

      <button className="omni" type="button" aria-label="Search or run a command" onClick={onOpenSearch}>
        <Icon name="search" />
        Search callsign, MMSI, place, or ask the analyst…
        <span className="kbd">⌘K</span>
      </button>

      <div className="cluster">
        <div
          className="cls"
          title={`${greenFeeds} of ${totalFeeds} live feeds`}
          role="status"
          aria-label={`${greenFeeds} of ${totalFeeds} live feeds healthy`}
        >
          <span className="dot" style={{ background: allGreen ? 'var(--ok)' : 'var(--warn)' }} />
          <span>
            FEEDS {greenFeeds}/{totalFeeds}
          </span>
        </div>

        <div className="clock" aria-label="Zulu time">
          {fmtZulu(nowMs)}
        </div>

        {aircraftCount !== undefined && (
          <div className="stat">
            <b>{fmtCount(aircraftCount)}</b>
            <small>Aircraft</small>
          </div>
        )}

        {vesselCount !== undefined && (
          <div className="stat">
            <b>{fmtCount(vesselCount)}</b>
            <small>Vessels</small>
          </div>
        )}

        <button
          className="iconbtn"
          type="button"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-pressed={theme === 'light'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>

        <button className="iconbtn" type="button" aria-label="Settings" onClick={onOpenSettings}>
          <Icon name="settings" />
        </button>

        <div className="usermenu" ref={menuRef}>
          <button
            className="iconbtn"
            type="button"
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls="nrm-usermenu-pop"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="user" />
          </button>

          {menuOpen && (
            <div className="usermenu-pop" id="nrm-usermenu-pop" role="menu" aria-label="Account">
              <div className="usermenu-head" role="presentation">
                {modeLabel}
              </div>
              <button className="usermenu-item" type="button" role="menuitem" onClick={switchToProfessional}>
                <Icon name="grid" />
                Switch to Professional dashboard
              </button>
              <button className="usermenu-item" type="button" role="menuitem" onClick={openSettingsFromMenu}>
                <Icon name="settings" />
                Settings
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
