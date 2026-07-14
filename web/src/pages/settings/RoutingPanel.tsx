import { useState } from 'preact/hooks';
import type { RoutingConfig } from '../../api';
import { SettingsSection, SaveBar, type SaveCtx } from './SettingsSection';
import s from '../pages.module.css';

// Cost-vs-speed weight. This is a single number with a real consequence, so it is presented as the
// trade-off it actually is rather than as an abstract 0–1 dial: at 0 the first available key wins
// (fastest); as it rises, a cheaper model is increasingly preferred among the candidates that could
// serve the request. It never overrides tier or capability — it is a tiebreaker, and the copy says so.
function weightLabel(w: number): string {
  if (w === 0)    return 'Speed — the first available key wins';
  if (w <= 0.33)  return 'Mostly speed, with a nudge toward cheaper models';
  if (w <= 0.66)  return 'Balanced — cost and availability weigh about equally';
  if (w < 1)      return 'Mostly cost — a cheaper model is strongly preferred';
  return 'Cost — always take the cheapest candidate that can serve the request';
}

export function RoutingPanel() {
  return (
    <SettingsSection<RoutingConfig>
      path="/admin/settings/routing"
      title="Routing"
      description="How Nexus breaks a tie when several models could serve the same request. It never changes which models are eligible — capability and tier decide that first."
    >
      {(data, ctx) => <RoutingForm data={data} ctx={ctx} />}
    </SettingsSection>
  );
}

function RoutingForm({ data, ctx }: { data: RoutingConfig; ctx: SaveCtx<RoutingConfig> }) {
  const [weight, setWeight] = useState(data.costWeight);
  const dirty = weight !== data.costWeight;

  return (
    <>
      <div class={s.sliderRow}>
        <input
          type="range" min={0} max={1} step={0.05} value={weight}
          class={s.slider}
          aria-label="Cost versus speed weight"
          onInput={(e) => setWeight(parseFloat((e.target as HTMLInputElement).value))}
        />
        <span class={s.sliderVal}>{weight.toFixed(2)}</span>
      </div>
      <p class={s.sliderHint}>{weightLabel(weight)}</p>

      <SaveBar ctx={ctx} dirty={dirty} onSave={() => ctx.save({ costWeight: weight })} />
    </>
  );
}
