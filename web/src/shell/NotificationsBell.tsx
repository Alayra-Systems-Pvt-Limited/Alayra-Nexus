import { useState, useEffect, useRef } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Bell, CheckCheck, KeyRound, Zap, ShieldAlert, Wallet, Layers, BellOff, type LucideIcon } from 'lucide-preact';
import { POST, type NotificationsFeed, type NotificationRow } from '../api';
import { useApi } from '../hooks/useApi';
import { relativeTime } from '../lib/format';
import { clsx } from 'clsx';
import s from './shell.module.css';

/**
 * The live notifications bell (Phase 7.11; restyled with severity in 7.16c). Alerts are recorded
 * whenever raised, regardless of whether a delivery channel is set up, which is what makes this feed
 * real on a default install rather than permanently empty.
 *
 * Each alert now carries a severity that tints its icon — a dead key (critical) reads differently
 * from a cooling breaker (warning) at a glance — and the feed is grouped by day and filterable to
 * unread. Selecting an alert marks it read and jumps to the section that raised it.
 */

const POLL_MS = 60_000;

// Per-event icon, so the eye can triage the feed without reading every title.
const ICONS: Record<string, LucideIcon> = {
  keyBanned:       KeyRound,
  breakerOpened:   Zap,
  adminLockout:    ShieldAlert,
  budgetThreshold: Wallet,
  tierExhausted:   Layers,
};

// Day bucket for grouping. Compared on local midnight so "Today"/"Yesterday" match the operator's
// clock, not UTC.
function dayBucket(iso: string, now: Date): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupByDay(rows: NotificationRow[], now: Date): { label: string; items: NotificationRow[] }[] {
  const groups: { label: string; items: NotificationRow[] }[] = [];
  for (const n of rows) {
    const label = dayBucket(n.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [tab, setTab]   = useState<'all' | 'unread'>('all');
  const [bump, setBump] = useState(false); // fires the badge pop when the unread count climbs
  const { data, reload } = useApi<NotificationsFeed>('/admin/notifications?limit=20');
  const { route } = useLocation();
  const wrapRef = useRef<HTMLDivElement>(null);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const t = setInterval(() => reloadRef.current(), POLL_MS);
    return () => clearInterval(t);
  }, []);

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
  const hasCriticalUnread = feed.some((n) => !n.read && n.severity === 'critical');

  // Pop the badge when a poll brings the unread count *up* — a new alert deserves a beat of motion.
  const prevUnread = useRef(unread);
  useEffect(() => {
    if (unread > prevUnread.current) { setBump(true); const t = setTimeout(() => setBump(false), 400); return () => clearTimeout(t); }
    prevUnread.current = unread;
  }, [unread]);

  const shown  = tab === 'unread' ? feed.filter((n) => !n.read) : feed;
  const groups = groupByDay(shown, new Date());

  const openAlert = async (n: NotificationRow) => {
    setOpen(false);
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
        {unread > 0 && (
          <span class={clsx(s.bellCount, hasCriticalUnread && s.bellCountCritical, bump && s.bellCountBump)}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
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

          <div class={s.bellTabs} role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'all'}
              class={clsx(s.bellTab, tab === 'all' && s.bellTabOn)} onClick={() => setTab('all')}>All</button>
            <button type="button" role="tab" aria-selected={tab === 'unread'}
              class={clsx(s.bellTab, tab === 'unread' && s.bellTabOn)} onClick={() => setTab('unread')}>
              Unread{unread > 0 ? ` (${unread > 99 ? '99+' : unread})` : ''}
            </button>
          </div>

          {shown.length === 0 ? (
            <div class={s.bellEmptyWrap}>
              <BellOff size={22} class={s.bellEmptyIcon} />
              <p class={s.bellEmpty}>
                {tab === 'unread'
                  ? 'You’re all caught up.'
                  : 'Nothing to report. Alerts about banned keys, open circuit breakers, budgets and sign-in lockouts appear here.'}
              </p>
            </div>
          ) : (
            <div class={s.bellList}>
              {groups.map((g) => (
                <div key={g.label} class={s.bellGroup}>
                  <div class={s.bellGroupLabel}>{g.label}</div>
                  <ul class={s.bellGroupItems}>
                    {g.items.map((n) => {
                      const Icon = ICONS[n.type] ?? Bell;
                      return (
                        <li key={n.id}>
                          <button
                            type="button"
                            class={clsx(s.bellItem, !n.read && s.bellUnread)}
                            onClick={() => openAlert(n)}
                          >
                            <span class={clsx(s.bellIcon, s[`sev_${n.severity}`])}><Icon size={15} /></span>
                            <span class={s.bellItemMain}>
                              <span class={s.bellItemTop}>
                                <span class={s.bellItemTitle}>{n.title}</span>
                                <span class={s.bellWhen} title={n.createdAt}>{relativeTime(n.createdAt)}</span>
                              </span>
                              <span class={s.bellBody}>{n.body}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
