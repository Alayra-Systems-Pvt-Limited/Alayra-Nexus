import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { CopyButton } from './CopyButton';

// The clipboard is a browser API jsdom does not implement; stub writeText and watch what reaches it.
const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => vi.useRealTimers());

describe('CopyButton', () => {
  it('copies a sync value and flips to a confirmation, then back', async () => {
    vi.useFakeTimers();
    render(<CopyButton value="nx_secret" label="Copy" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('nx_secret'));
    // The label becomes the confirmation…
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    // …and reverts once the window passes, so the control is reusable.
    vi.advanceTimersByTime(1500);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument());
  });

  it('resolves an async value at click time — the reveal-then-copy path', async () => {
    // The team-key case: the plaintext exists only after a server reveal, fetched on click.
    const getValue = vi.fn(() => Promise.resolve('revealed-key'));
    render(<CopyButton getValue={getValue} iconOnly ariaLabel="Copy team key" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy team key' }));
    await waitFor(() => expect(getValue).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('revealed-key');
  });

  it('surfaces a failed reveal through onError instead of copying', async () => {
    const boom = new Error('403');
    const getValue = vi.fn(() => Promise.reject(boom));
    const onError = vi.fn();
    render(<CopyButton getValue={getValue} iconOnly ariaLabel="Copy" onError={onError} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(boom));
    expect(writeText).not.toHaveBeenCalled();
  });
});
