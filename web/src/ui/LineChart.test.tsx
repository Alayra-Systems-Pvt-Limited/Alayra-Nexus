import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { LineChart } from './LineChart';

describe('LineChart', () => {
  it('shows an empty message with no data', () => {
    render(<LineChart data={[]} />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('draws an area and a line path when given data', () => {
    const { container } = render(<LineChart data={[1, 5, 3, 8]} />);
    expect(container.querySelectorAll('path').length).toBe(2);
  });

  it('renders as an accessible image with its label', () => {
    render(<LineChart data={[1, 2, 3]} ariaLabel="Tokens over 7 days" />);
    expect(screen.getByRole('img', { name: 'Tokens over 7 days' })).toBeInTheDocument();
  });

  // Regression: the chart used a fixed 320×120 viewBox with preserveAspectRatio="none", so the
  // browser stretched it ~1.9× to fill the row — softening every diagonal (the "blur") and rendering
  // it far taller than asked (the "half a layer" over the chart). It now renders 1:1: an explicit
  // pixel height and a viewBox whose height matches it, with no non-uniform stretch.
  it('renders in true pixel space — explicit height, matching viewBox, no forced stretch', () => {
    const { container } = render(<LineChart data={[1, 2, 3]} height={140} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('height')).toBe('140');
    expect(svg.getAttribute('viewBox')!.endsWith(' 140')).toBe(true); // "0 0 <width> 140"
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull();
  });
});
