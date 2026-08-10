import { AlertTriangle } from 'lucide-preact';
import { useApi } from '../../hooks/useApi';
import { isUnpriced } from '../../lib/pricing';
import type { ModelsResponse } from '../../api';
import s from '../pages.module.css';

/**
 * Says out loud when the cost figures above are incomplete.
 *
 * A model with no price contributes exactly $0 to every total on this page — not an error, not a
 * gap, just a number quietly smaller than the truth. That is the worst possible failure for a
 * spend dashboard: it is indistinguishable from cheap. Most providers publish no pricing at all
 * (only OpenRouter and Groq do among the ones verified), so on a normal install this is the common
 * case, not an edge one.
 *
 * Counts only ACTIVE models: a paused or retired one serves nothing, so it cannot be distorting
 * anything, and nagging about it would be noise.
 *
 * Renders nothing when the registry can't be read. This is a footnote on someone else's page — if
 * the extra call fails, the page it annotates is still correct, and an error box about a banner
 * would be worse than the banner's absence.
 */
export function UnpricedNotice() {
  const { data } = useApi<ModelsResponse>('/admin/models');
  // Not just `!data`: a response can arrive without a `models` array — an error envelope, a proxy
  // interposing its own body, an older gateway. Reaching straight for `.filter` threw and took the
  // whole Analytics page down with it, so a banner about incomplete costs destroyed the costs it
  // was annotating. Nothing on this page is worth that.
  if (!Array.isArray(data?.models)) return null;

  const unpriced = data.models.filter((m) => m.status === 'active' && isUnpriced(m));
  if (unpriced.length === 0) return null;

  const names = unpriced.slice(0, 3).map((m) => m.modelString).join(', ');
  const rest  = unpriced.length - Math.min(3, unpriced.length);

  return (
    <div class={s.unpricedNotice} role="status">
      <AlertTriangle size={15} class={s.unpricedIcon} />
      <div>
        <b>{unpriced.length} active model{unpriced.length === 1 ? ' has' : 's have'} no price set</b>, so
        cost above is a floor, not a total — requests through {unpriced.length === 1 ? 'it' : 'them'} count as $0.
        <br />
        <span class={s.unpricedNames}>{names}{rest > 0 ? ` and ${rest} more` : ''}</span>
        {' '}— set prices from <b>Nexus → the pool → the model row</b>.
      </div>
    </div>
  );
}
