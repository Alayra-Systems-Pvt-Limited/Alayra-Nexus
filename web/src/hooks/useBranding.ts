import { useEffect, useRef } from 'preact/hooks';
import { useApi } from './useApi';
import type { Branding } from '../api';

/** Fired after branding is saved, so every view showing it re-reads at once. */
export const BRANDING_CHANGED = 'nx:branding';

/** Tell every mounted `useBranding` that the stored branding changed. */
export function announceBrandingChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(BRANDING_CHANGED));
}

// The operator's branding, read from the public `GET /branding` so the sign-in screen can show it
// before anyone has a session. Always resolves to a usable value: an unset, failed or still-loading
// read falls back to empty strings, and each caller substitutes the product's own name and mark —
// so the dashboard never flashes a blank brand while this is in flight.
//
// Each caller holds its own read, so a save in Settings would otherwise leave the sidebar showing
// the old name until a reload. Rather than hoisting branding into global state for one string and
// one image, a save announces itself and every reader refetches — the same event idiom the session
// gate already uses for `nx:unauthorized`.
export function useBranding(): Branding {
  const { data, reload } = useApi<Branding>('/branding');

  // `reload` is a fresh closure each render; going through a ref keeps the subscription set up once
  // instead of being torn down and rebuilt on every render.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const onChange = () => reloadRef.current();
    window.addEventListener(BRANDING_CHANGED, onChange);
    return () => window.removeEventListener(BRANDING_CHANGED, onChange);
  }, []);

  return data ?? { companyName: '', logoDataUri: '' };
}
