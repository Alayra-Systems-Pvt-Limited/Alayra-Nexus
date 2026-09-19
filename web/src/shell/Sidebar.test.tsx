import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { Sidebar } from './Sidebar';
import { SECTIONS } from '../nav';

describe('Sidebar', () => {
  it('renders every section from the information architecture', () => {
    render(<LocationProvider><Sidebar /></LocationProvider>);
    for (const section of SECTIONS) {
      expect(screen.getByText(section.label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Enterprise')).not.toBeInTheDocument();
  });

  it('marks the current route active (Overview at /)', () => {
    render(<LocationProvider><Sidebar /></LocationProvider>);
    const overview = screen.getByText('Overview').closest('a');
    expect(overview).toHaveAttribute('aria-current', 'page');
  });
});
