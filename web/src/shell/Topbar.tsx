import { LogOut } from 'lucide-preact';
import { ThemeToggle } from './ThemeToggle';
import { NotificationsBell } from './NotificationsBell';
import { clearToken } from '../api';
import s from './shell.module.css';

/**
 * The top bar: live status, theme toggle, notifications, and the account chip. Sign-out (Phase 7.9b)
 * clears the session token and fires `nx:unauthorized`, which App listens for to drop back to the
 * login screen. The bell owns its own feed and count (P7.11). The account name stays a placeholder
 * until real admin identities land in P7.13 — there is no user to name yet.
 */
function signOut() {
  clearToken();
  window.dispatchEvent(new CustomEvent('nx:unauthorized'));
}

export function Topbar() {
  return (
    <header class={s.topbar}>
      <span class={s.livePill}><span class={s.pulse} />LIVE</span>
      <div class={s.topSpacer} />
      <ThemeToggle />
      <NotificationsBell />
      <div class={s.account}>
        <span class={s.avatar}>A</span>
        <span class={s.accountName}>Admin</span>
        <button type="button" class={s.iconChip} aria-label="Sign out" title="Sign out" onClick={signOut}><LogOut size={16} /></button>
      </div>
    </header>
  );
}
