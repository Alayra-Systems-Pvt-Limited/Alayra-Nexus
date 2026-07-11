import { useEffect, useState } from 'preact/hooks';
import { GET } from '../api';

// One small seam every data-backed page loads through: fetch a GET endpoint, expose
// loading / error / data, and a `reload()` to refetch. A page never touches fetch directly, so
// loading and error states look the same everywhere and an unmounted view never sets state.

interface State<T> { data: T | null; loading: boolean; error: string | null; }

export function useApi<T>(path: string): State<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    GET<T>(path).then(
      (data) => { if (alive) setState({ data, loading: false, error: null }); },
      (e: unknown) => {
        if (alive) setState({ data: null, loading: false, error: e instanceof Error ? e.message : 'Request failed' });
      },
    );
    return () => { alive = false; };
  }, [path, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
