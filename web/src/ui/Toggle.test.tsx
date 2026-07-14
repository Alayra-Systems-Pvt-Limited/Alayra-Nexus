import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('reports its state and its meaning', () => {
    render(<Toggle checked onChange={vi.fn()} label="Serve from cache" hint="A hit costs nothing." />);
    const sw = screen.getByRole('switch', { name: 'Serve from cache' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('A hit costs nothing.')).toBeInTheDocument();
  });

  it('fires exactly once per click on the switch', () => {
    // Regression guard. The switch was originally wrapped in a <label>; because a <button> is a
    // labelable element, the label re-dispatched the click to it, so every toggle fired twice and
    // landed back where it started — the control silently did nothing at all.
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Allow private addresses" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('fires once when the row (not the switch) is clicked', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Send alerts" />);
    fireEvent.click(screen.getByText('Send alerts'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Locked" disabled />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByText('Locked'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
