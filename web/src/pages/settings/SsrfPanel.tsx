import { useState } from 'preact/hooks';
import { X, Plus } from 'lucide-preact';
import { Toggle, Input, Button, Badge } from '../../ui';
import type { SsrfConfig } from '../../api';
import { SettingsSection, SaveBar, type SaveCtx } from './SettingsSection';
import s from '../pages.module.css';

// The network policy that decides which upstream addresses Nexus is willing to call. This is the one
// settings panel where a careless change has a security consequence rather than a cost one, so the
// dangerous switch is labelled as dangerous and the environment-supplied entries are shown as the
// read-only facts they are.
export function SsrfPanel() {
  return (
    <SettingsSection<SsrfConfig>
      path="/admin/settings/ssrf"
      title="Network policy"
      description="Which upstream addresses the gateway is allowed to reach. Private and internal addresses are refused by default."
    >
      {(data, ctx) => <SsrfForm data={data} ctx={ctx} />}
    </SettingsSection>
  );
}

function SsrfForm({ data, ctx }: { data: SsrfConfig; ctx: SaveCtx<SsrfConfig> }) {
  const [allowPrivate, setAllowPrivate] = useState(data.allowPrivate);
  const [list, setList]   = useState<string[]>(data.allowList);
  const [entry, setEntry] = useState('');

  const dirty = allowPrivate !== data.allowPrivate
    || list.length !== data.allowList.length
    || list.some((h, i) => h !== data.allowList[i]);

  // A bare host or host:port — no scheme, no path. Mirrors the gateway's own rule, so a bad entry is
  // rejected here rather than bounced back from the server.
  const valid = /^[a-z0-9.:_-]+$/i.test(entry.trim());
  const add = () => {
    const h = entry.trim();
    if (!h || !valid || list.includes(h) || list.length >= 50) return;
    setList((l) => [...l, h]);
    setEntry('');
  };

  return (
    <>
      <Toggle
        checked={allowPrivate}
        onChange={setAllowPrivate}
        label="Allow private and internal addresses"
        hint="Off is correct for almost every deployment. Turning it on lets a provider URL point at your own network."
      />

      {allowPrivate && (
        <p class={s.dangerNote}>
          <b>This lowers a real defence.</b> With it on, anyone who can add a provider can aim the
          gateway at an internal service. Only enable it if you are running a provider on your own
          network, and prefer adding that one host to the allow-list below instead.
        </p>
      )}

      <div class={s.allowHead}>Allow-listed hosts</div>
      <div class={s.chipRow}>
        {list.length === 0 && <span class={s.chipEmpty}>None — only public addresses are reachable.</span>}
        {list.map((h) => (
          <span key={h} class={s.modelChip}>
            <span>{h}</span>
            <button type="button" aria-label={`Remove ${h}`} onClick={() => setList((l) => l.filter((x) => x !== h))}>
              <X size={11} />
            </button>
          </span>
        ))}
      </div>

      <div class={s.allowAdd}>
        <Input
          value={entry}
          placeholder="host or host:port"
          onInput={(e) => setEntry((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <Button size="sm" onClick={add} disabled={!entry.trim() || !valid || list.includes(entry.trim())}>
          <Plus size={13} /> Add
        </Button>
      </div>
      {entry.trim() && !valid && <p class={s.fieldWarn}>Use a bare host or host:port — no https://, no path.</p>}

      {data.envAllowList.length > 0 && (
        <>
          <div class={s.allowHead}>From the environment <span class={s.allowHeadHint}>read-only</span></div>
          <div class={s.chipRow}>
            {data.envAllowList.map((h) => <Badge key={h} tone="gray">{h}</Badge>)}
          </div>
          <p class={s.setHint}>These are set where the gateway is deployed and cannot be changed from here.</p>
        </>
      )}

      <SaveBar ctx={ctx} dirty={dirty} onSave={() => ctx.save({ allowPrivate, allowList: list })} />
    </>
  );
}
