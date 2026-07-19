import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';

const get  = vi.fn();
const post = vi.fn();
const route = vi.fn();
vi.mock('../api', () => ({ GET: (p: string) => get(p), POST: (p: string) => post(p) }));

// The bell navigates via preact-iso's router; stub `route` so the jump is observable without
// mounting a whole router tree.
vi.mock('preact-iso', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLocation: () => ({ route }),
}));

import { NotificationsBell } from './NotificationsBell';

const alert = (over: Record<string, unknown> = {}) => ({
  id: 'n1', type: 'keyBanned', severity: 'critical', title: 'A openai key was auto-banned',
  body: 'That credential is dead — traffic is degrading until you replace it.',
  section: 'nexus', read: false, createdAt: new Date(Date.now() - 60_000).toISOString(),
  ...over,
});

const renderBell = () => render(<LocationProvider><NotificationsBell /></LocationProvider>);

beforeEach(() => {
  get.mockReset(); post.mockReset(); route.mockReset();
  get.mockResolvedValue({ notifications: [alert()], unreadCount: 1 });
  post.mockResolvedValue({ success: true });
});

describe('NotificationsBell', () => {
  it('shows the unread count from the feed', async () => {
    renderBell();
    await waitFor(() => expect(screen.getByRole('button', { name: /1 unread/i })).toBeInTheDocument());
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('reports the true unread total even when it exceeds the page shown', async () => {
    get.mockResolvedValue({ notifications: [alert()], unreadCount: 130 });
    renderBell();
    await waitFor(() => expect(screen.getByText('99+')).toBeInTheDocument());
  });

  it('opens the panel and lists the alert', async () => {
    renderBell();
    await waitFor(() => expect(screen.getByRole('button', { name: /1 unread/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /1 unread/i }));
    expect(await screen.findByText('A openai key was auto-banned')).toBeInTheDocument();
  });

  it('marks an alert read and jumps to the section that raised it', async () => {
    // The whole point of the feed: an alert saying a key died is only useful if it lands you where
    // you can replace it.
    renderBell();
    await waitFor(() => expect(screen.getByRole('button', { name: /1 unread/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /1 unread/i }));

    fireEvent.click(await screen.findByText('A openai key was auto-banned'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/notifications/n1/read'));
    expect(route).toHaveBeenCalledWith('/nexus');
  });

  it('does not re-mark an already-read alert, but still navigates', async () => {
    get.mockResolvedValue({ notifications: [alert({ read: true })], unreadCount: 0 });
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: /0 unread/i }));
    fireEvent.click(await screen.findByText('A openai key was auto-banned'));
    await waitFor(() => expect(route).toHaveBeenCalledWith('/nexus'));
    expect(post).not.toHaveBeenCalled();
  });

  it('marks all read', async () => {
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark all read/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/notifications/read-all'));
  });

  it('groups the feed by day under a Today header', async () => {
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    expect(await screen.findByText('Today')).toBeInTheDocument();
  });

  it('the Unread filter hides read alerts', async () => {
    get.mockResolvedValue({
      notifications: [
        alert({ id: 'r', read: true, title: 'A read alert' }),
        alert({ id: 'u', read: false, title: 'An unread alert' }),
      ],
      unreadCount: 1,
    });
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    // All tab shows both…
    expect(await screen.findByText('A read alert')).toBeInTheDocument();
    // …switching to Unread drops the read one.
    fireEvent.click(screen.getByRole('tab', { name: /unread/i }));
    expect(screen.queryByText('A read alert')).not.toBeInTheDocument();
    expect(screen.getByText('An unread alert')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing to report, with no badge', async () => {
    get.mockResolvedValue({ notifications: [], unreadCount: 0 });
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: /0 unread/i }));
    expect(await screen.findByText(/nothing to report/i)).toBeInTheDocument();
    // A quiet gateway shows no count at all rather than a "0".
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    // …and nothing to mark, so the control is absent rather than dead.
    expect(screen.queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument();
  });
});
