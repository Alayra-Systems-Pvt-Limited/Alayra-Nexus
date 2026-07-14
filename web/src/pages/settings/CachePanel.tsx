import { useState } from 'preact/hooks';
import { Toggle, Field, Input } from '../../ui';
import type { CacheConfig } from '../../api';
import { SettingsSection, SaveBar, type SaveCtx } from './SettingsSection';
import s from '../pages.module.css';

// Response cache. The TTL is the whole risk here, so it is spelled out rather than left as a number:
// a cached answer is replayed without ever asking the provider, which means a stale one is served
// for as long as the TTL says. That is a real footgun and the operator deserves to be told, not
// protected from the truth.
const PRESETS = [
  { label: '5 minutes', secs: 300 },
  { label: '1 hour',    secs: 3600 },
  { label: '1 day',     secs: 86400 },
];

function humanTtl(secs: number): string {
  if (secs < 60)    return `${secs} second${secs === 1 ? '' : 's'}`;
  if (secs < 3600)  return `${Math.round(secs / 60)} minutes`;
  if (secs < 86400) return `${(secs / 3600).toFixed(secs % 3600 ? 1 : 0)} hours`;
  return `${(secs / 86400).toFixed(secs % 86400 ? 1 : 0)} days`;
}

export function CachePanel() {
  return (
    <SettingsSection<CacheConfig>
      path="/admin/settings/cache"
      title="Response cache"
      description="Serve an identical repeat request straight from cache instead of calling the provider again. Off by default — a fresh gateway caches nothing until you turn this on."
    >
      {(data, ctx) => <CacheForm data={data} ctx={ctx} />}
    </SettingsSection>
  );
}

function CacheForm({ data, ctx }: { data: CacheConfig; ctx: SaveCtx<CacheConfig> }) {
  // Seeded once on mount; SettingsSection remounts this form after a save so it re-seeds from what
  // the gateway actually stored.
  const [enabled, setEnabled] = useState(data.enabled);
  const [ttl, setTtl]         = useState(String(data.ttlSeconds));

  const ttlSeconds = Math.max(1, parseInt(ttl, 10) || data.ttlSeconds);
  const dirty = enabled !== data.enabled || ttlSeconds !== data.ttlSeconds;

  return (
    <>
      <Toggle
        checked={enabled}
        onChange={setEnabled}
        label="Serve repeat requests from cache"
        hint="A cache hit costs nothing and returns instantly. Analytics shows what it has saved you."
      />

      <Field label="How long an answer stays fresh" hint="seconds">
        <Input type="number" min={1} max={2592000} value={ttl} onInput={(e) => setTtl((e.target as HTMLInputElement).value)} />
      </Field>

      <div class={s.presetRow}>
        {PRESETS.map((p) => (
          <button key={p.secs} type="button" class={s.preset} onClick={() => setTtl(String(p.secs))}>{p.label}</button>
        ))}
      </div>

      <p class={s.warnNote}>
        <b>Staleness is the trade-off.</b> For {humanTtl(ttlSeconds)} after an answer is cached, an
        identical request gets that same answer — even if the underlying data changed in the
        meantime. Keep it short if your prompts read from anything that moves.
      </p>

      <SaveBar ctx={ctx} dirty={dirty} onSave={() => ctx.save({ enabled, ttlSeconds })} />
    </>
  );
}
