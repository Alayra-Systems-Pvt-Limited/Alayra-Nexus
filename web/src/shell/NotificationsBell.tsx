import { useState, useEffect, useRef } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Bell, CheckCheck } from 'lucide-preact';
import { POST, type NotificationsFeed, type NotificationRow } from '../api';
import { useApi } from '../hooks/useApi';
import { relativeTime } from '../lib/format';
import s from './shell.module.css';

/**
 * The live notifications bell (Phase 7.11). Until now this was a styled placeholder with a hardcoded
 * count, because alerts were email/webhook only and were never written down — there was nothing to
 * read. They are now recorded whenever raised, regardless of whether a delivery channel is set up,
 * which is what makes this feed real on a default install rather than permanently empty.
 *
 * Selecting an alert marks it read and jumps to the section that raised it: an alert saying a key
 * died is only useful if it lands you where you can replace it.
 */

const POLL_MS = 60_000;

// A quiet re-read rather than a socket: alerts are coalesced to at most one per window per source,
// so a minute of latency on a badge is imperceptible and costs one small query.
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<NotificationsFeed>('/admin/notifications?limit=20');
  const { route } = useLocation();
  const wrapRef = useRef<HTMLDivElement>(null);

  // `reload` is a fresh closure each render, so poll through a ref — depending on it directly would
  // tear down and rebuild the interval on every render and it would never fire.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const t = setInterval(() => reloadRef.current(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Close on an outside click or Escape — a panel that traps you is worse than no panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const feed   = data?.notifications ?? [];
  const unread = data?.unreadCount ?? 0;

  const openAlert = async (n: NotificationRow) => {
    setOpen(false);
    // Read state is a convenience, not a transaction: if marking fails the navigation still happens
    // and the badge simply corrects itself on the next poll.
    if (!n.read) { await POST(`/admin/notifications/${n.id}/read`).catch(() => {}); reload(); }
    if (n.section) route(`/${n.section}`);
  };

  const markAll = async () => {
    await POST('/admin/notifications/read-all').catch(() => {});
    reload();
  };

  return (
    <div class={s.bellWrap} ref={wrapRef}>
      <button
        type="button"
        class={s.iconChip}
        aria-label={`Notifications (${unread} unread)`}
        aria-expanded={open}
        title="Notifications"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={17} />
        {unread > 0 && <span class={s.bellCount}>{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div class={s.bellPanel} role="dialog" aria-label="Notifications">
          <div class={s.bellHead}>
            <span class={s.bellTitle}>Notifications</span>
            {unread > 0 && (
              <button type="button" class={s.bellMarkAll} onClick={markAll}>
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </div>

          {feed.length === 0 ? (
            <p class={s.bellEmpty}>
              Nothing to report. Alerts about banned keys, open circuit breakers, budgets and sign-in
              lockouts appear here.
            </p>
          ) : (
            <ul class={s.bellList}>
              {feed.map((n) => (
                <li key={n.id}>
                  <button type="button" class={`${s.bellItem} ${n.read ? '' : s.bellUnread}`} onClick={() => openAlert(n)}>
                    <span class={s.bellItemTop}>
                      {!n.read && <span class={s.bellDot} aria-hidden="true" />}
                      <span class={s.bellItemTitle}>{n.title}</span>
                      <span class={s.bellWhen} title={n.createdAt}>{relativeTime(n.createdAt)}</span>
                    </span>
                    <span class={s.bellBody}>{n.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
