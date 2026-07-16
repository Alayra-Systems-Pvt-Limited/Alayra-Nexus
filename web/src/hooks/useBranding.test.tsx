import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';

const get = vi.fn();
vi.mock('../api', () => ({ GET: (p: string) => get(p) }));

import { useBranding, announceBrandingChange } from './useBranding';

function Probe() {
  const b = useBranding();
  return <span data-testid="name">{b.companyName || 'Alayra Nexus'}</span>;
}

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ companyName: 'Acme Corp', logoDataUri: '' });
});

describe('useBranding', () => {
  it('reads the public branding endpoint', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Acme Corp'));
    expect(get).toHaveBeenCalledWith('/branding');
  });

  it('falls back to the product name while loading or when unset', async () => {
    get.mockResolvedValue({ companyName: '', logoDataUri: '' });
    render(<Probe />);
    // Never a blank brand: the fallback is in place on the very first paint.
    expect(screen.getByTestId('name')).toHaveTextContent('Alayra Nexus');
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByTestId('name')).toHaveTextContent('Alayra Nexus');
  });

  it('survives a failed read rather than rendering nothing', async () => {
    get.mockRejectedValue(new Error('gateway down'));
    render(<Probe />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByTestId('name')).toHaveTextContent('Alayra Nexus');
  });

  it('re-reads when a save announces a change, so the sidebar cannot go stale', async () => {
    // Caught in live verification: saving in Settings left the sidebar showing the old name until a
    // page reload, because each reader holds its own fetch.
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Acme Corp'));

    get.mockResolvedValue({ companyName: 'Globex Ltd', logoDataUri: '' });
    announceBrandingChange();
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Globex Ltd'));
  });
});
