import { useEffect, useState } from 'preact/hooks';
import { LogOut, Menu } from 'lucide-preact';
import { ThemeToggle } from './ThemeToggle';
import { NotificationsBell } from './NotificationsBell';
import { POST, clearToken, getIdentity, type AdminRole } from '../api';
import s from './shell.module.css';

// The top bar: live status, theme toggle, notifications, and the account chip.
//
// The LIVE pill is real now (7.13b): it polls GET /health and says OFFLINE in grey when a poll
// fails. It was the hardcoded word "LIVE" from the day the shell was built — a decoration that
// would have glowed green through an outage.
//
// The account chip names the person the gateway believes you are (7.13a stored it; nothing
// displayed it). A token-minted session has a role but no person, and says so.

const HEALTH_EVERY_MS = 30_000;

function signOut() {
  // Tell the server first so the session actually DIES — clearToken alone would leave it alive
  // until its TTL, still listed in "Where you're signed in" after the person watched themselves
  // sign out. Fire-and-forget: whatever the server says, this browser is done.
  POST('/admin/logout').catch(() => { /* signed out locally regardless */ });
  clearToken();
  window.dispatchEvent(new CustomEvent('nx:unauthorized'));
}

const ROLE_LABEL: Record<AdminRole, string> = { owner: 'Owner', admin: 'Admin', viewer: 'Viewer' };

export function Topbar({ onMenu, navOpen = false }: { onMenu?: () => void; navOpen?: boolean }) {
  const identity = getIdentity();
  const name = identity?.name ?? 'API token';
  const initial = (identity?.name?.trim()[0] ?? '•').toUpperCase();

  // null = not asked yet: render no pill rather than claim either state without having checked.
  const [alive, setAlive] = useState<boolean | null>(null);
  useEffect(() => {
    let stopped = false;
    const probe = async () => {
      try {
        // Plain fetch, not api(): /health is unauthenticated, and a mid-outage failure here must
        // not be mistaken for an expired session and log anyone out.
        const r = await fetch('/health');
        if (!stopped) setAlive(r.ok);
      } catch {
        if (!stopped) setAlive(false);
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), HEALTH_EVERY_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  return (
    <header class={s.topbar}>
      {/* Only rendered as a control on narrow screens — CSS hides it above the drawer breakpoint. */}
      <button
        type="button"
        class={s.menuBtn}
        onClick={onMenu}
        aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={navOpen}
      >
        <Menu size={18} />
      </button>
      {alive !== null && (alive
        ? <span class={s.livePill}><span class={s.pulse} />LIVE</span>
        : <span class={s.offlinePill}><span class={s.deadDot} />OFFLINE</span>)}
      <div class={s.topSpacer} />
      <ThemeToggle />
      <NotificationsBell />
      <div class={s.account}>
        <span class={s.avatar}>{initial}</span>
        <span class={s.accountName}>{name}</span>
        {identity && <span class={s.roleChip}>{ROLE_LABEL[identity.role]}</span>}
        <button type="button" class={s.iconChip} aria-label="Sign out" title="Sign out" onClick={signOut}><LogOut size={16} /></button>
      </div>
    </header>
  );
}
