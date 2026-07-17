import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { QrCode } from './QrCode';

// These assert the QR is genuinely encoded in the DOM — a real module grid, not a placeholder — so
// a regression that broke the generator (or swapped in an empty <svg>) fails here rather than in a
// user's authenticator app, where "it won't scan" gives no clue why.

function svgOf(container: HTMLElement) {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no svg rendered');
  return svg;
}

describe('QrCode', () => {
  it('renders an SVG with a white ground and a non-empty dark module path', () => {
    const { container } = render(<QrCode value="otpauth://totp/Alayra:abbas?secret=ABC123" />);
    const svg = svgOf(container);

    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff');
    const path = svg.querySelector('path');
    expect(path?.getAttribute('fill')).toBe('#000000');
    // A real code has many modules; a blank/failed render would have an empty or absent path.
    expect((path?.getAttribute('d') ?? '').length).toBeGreaterThan(100);
  });

  it('encodes the input — different values produce different module grids', () => {
    const a = svgOf(render(<QrCode value="otpauth://totp/A?secret=AAAA" />).container).querySelector('path')!.getAttribute('d');
    const b = svgOf(render(<QrCode value="otpauth://totp/B?secret=BBBB" />).container).querySelector('path')!.getAttribute('d');
    expect(a).not.toBe(b);
  });

  it('names itself for assistive tech', () => {
    const { container } = render(<QrCode value="x" label="Two-factor setup QR code" />);
    const svg = svgOf(container);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Two-factor setup QR code');
  });
});
