import { useState } from 'preact/hooks';
import { PUT, ApiError } from '../api';

// The save half of every settings panel. Loading is already handled by useApi; this is its mirror —
// PUT the draft, surface a real error message rather than a silent failure, and flash a confirmation
// so an operator is never left wondering whether the change actually took.
//
// The gateway's settings endpoints all return the freshly-stored config from their PUT, so `save`
// hands that back to the caller: the panel re-seeds from what the server actually persisted, not
// from what it hoped it sent.
export function useSave<T>(path: string) {
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [saved, setSaved]   = useState(false);

  const save = async (body: unknown): Promise<T | null> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const fresh = await PUT<T>(path, body);
      setSaved(true);
      // The confirmation is transient — it marks the moment, it does not become part of the page.
      setTimeout(() => setSaved(false), 2500);
      return fresh;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save. The change was not applied.');
      return null;
    } finally {
      setSaving(false);
    }
  };

  return { save, saving, error, saved };
}
