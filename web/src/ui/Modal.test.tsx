import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders its title and closes on the close button and Escape', () => {
    const onClose = vi.fn();
    render(<Modal title="Add provider pool" onClose={onClose}>body</Modal>);
    expect(screen.getByText('Add provider pool')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

/**
 * The tests above passed throughout a bug that made every text field in every dialog in the
 * dashboard hostile to type into — because they hand `Modal` a `vi.fn()`, whose identity never
 * changes, and no real caller does that.
 *
 * `Modal`'s focus effect listed `onClose` as a dependency, and every caller passes an inline arrow:
 * `onClose={() => !saving && setDraft(null)}`. That is a new function on every render. Typing one
 * character re-rendered the parent, so the effect re-ran: the cleanup restored focus to whatever
 * had opened the dialog, and the body moved focus to the dialog shell. The caret left the input
 * after a single keystroke, and it looked like a separate small bug on every screen it happened on.
 *
 * So the harness below is deliberately the shape every real caller has: state that changes as you
 * type, and an inline `onClose`.
 */
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [name, setName] = useState('');
  return (
    <Modal title="New team" onClose={() => onClose()}>
      <input
        aria-label="Name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <span data-testid="echo">{name}</span>
    </Modal>
  );
}

describe('Modal — focus survives typing', () => {
  it('keeps the caret in the field for a whole word, not one character', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByLabelText('Name');
    await user.click(input);
    await user.keyboard('Frontend');

    // The assertion that matters. With the effect re-running per keystroke, focus left after the
    // first character and the remaining seven went nowhere — this read 'F'.
    expect(input).toHaveValue('Frontend');
    expect(screen.getByTestId('echo')).toHaveTextContent('Frontend');
    expect(input).toHaveFocus();
  });

  it('still moves focus into the dialog when it opens', () => {
    render(<Harness />);
    // The accessibility behaviour the effect exists for, which the fix must not cost us.
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});

describe('Modal — Escape closes with the current handler', () => {
  it('calls the latest onClose, not the one captured on mount', async () => {
    const user = userEvent.setup();
    const seen: number[] = [];

    // A handler whose behaviour depends on state that changes while the dialog is open — which is
    // the real case: `() => !saving && setDraft(null)` reads `saving`. Reading `onClose` through a
    // ref keeps this correct; capturing it once on mount would act on the value the dialog opened
    // with, so a dialog mid-save would still close.
    function Stateful() {
      const [count, setCount] = useState(0);
      return (
        <Modal title="Counting" onClose={() => seen.push(count)}>
          <button type="button" onClick={() => setCount((c) => c + 1)}>bump</button>
        </Modal>
      );
    }

    render(<Stateful />);
    await user.click(screen.getByRole('button', { name: 'bump' }));
    await user.click(screen.getByRole('button', { name: 'bump' }));
    await user.keyboard('{Escape}');

    expect(seen).toEqual([2]);
  });

  it('stops listening for Escape once unmounted', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);

    unmount();
    await user.keyboard('{Escape}');

    // An empty dependency list means one subscribe and one unsubscribe. If that cleanup ever
    // stopped matching, a closed dialog would answer the Escape key for the rest of the session.
    expect(onClose).not.toHaveBeenCalled();
  });
});
