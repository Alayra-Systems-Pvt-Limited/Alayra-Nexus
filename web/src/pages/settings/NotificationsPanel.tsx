import { useState } from 'preact/hooks';
import { X, Plus } from 'lucide-preact';
import { Toggle, Input, Field, Button, Badge } from '../../ui';
import type { NotificationConfig, NotifyEvent } from '../../api';
import { SettingsSection, SaveBar, type SaveCtx } from './SettingsSection';
import s from '../pages.module.css';

// Operator alerts by email (Resend) and/or webhook. The stored API key is never sent back to the
// browser — only whether one is set and its mask — so the field is left blank on load and an empty
// field means "keep what you have", not "clear it". That is stated plainly, because the alternative
// is an operator wiping their own key by saving an unrelated change.
const EVENTS: { id: NotifyEvent; label: string; hint: string }[] = [
  { id: 'keyBanned',       label: 'A provider key is banned',        hint: 'Repeated authentication failures took a key out of service.' },
  { id: 'breakerOpened',   label: 'A key is taken out to cool',      hint: 'Repeated provider failures tripped the circuit breaker.' },
  { id: 'adminLockout',    label: 'An admin is locked out',          hint: 'Too many failed sign-in attempts.' },
  { id: 'budgetThreshold', label: 'A team crosses its budget',       hint: 'Spend passed 80% or 100% of the cap.' },
  { id: 'tierExhausted',   label: 'The gateway runs out of capacity', hint: 'Every key able to serve a request was unavailable — traffic is being refused.' },
];

export function NotificationsPanel() {
  return (
    <SettingsSection<NotificationConfig>
      path="/admin/settings/notifications"
      title="Notifications"
      description="Tell someone when the gateway is in trouble. Alerts are sent off the request path and are coalesced, so a flapping key can never flood an inbox."
    >
      {(data, ctx) => <NotificationsForm data={data} ctx={ctx} />}
    </SettingsSection>
  );
}

function NotificationsForm({ data, ctx }: { data: NotificationConfig; ctx: SaveCtx<NotificationConfig> }) {
  const [enabled, setEnabled] = useState(data.enabled);
  const [from, setFrom]       = useState(data.from);
  const [to, setTo]           = useState<string[]>(data.to);
  const [recipient, setRecip] = useState('');
  const [webhook, setWebhook] = useState(data.webhookUrl);
  const [apiKey, setApiKey]   = useState('');           // always blank on load — see the note above
  const [events, setEvents]   = useState(data.events);
  const [window, setWindow]   = useState(String(data.windowSeconds));

  const windowSeconds = Math.min(86400, Math.max(60, parseInt(window, 10) || 3600));
  const dirty = enabled !== data.enabled
    || from !== data.from
    || webhook !== data.webhookUrl
    || apiKey.length > 0
    || windowSeconds !== data.windowSeconds
    || JSON.stringify(to) !== JSON.stringify(data.to)
    || JSON.stringify(events) !== JSON.stringify(data.events);

  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient.trim());
  const addTo = () => {
    const e = recipient.trim();
    if (!e || !validEmail || to.includes(e) || to.length >= 20) return;
    setTo((l) => [...l, e]);
    setRecip('');
  };

  return (
    <>
      <Toggle checked={enabled} onChange={setEnabled} label="Send alerts" hint="When off, nothing is sent no matter which events are selected." />

      <div class={s.setGroup}>What to be told about</div>
      {EVENTS.map((e) => (
        <Toggle
          key={e.id}
          checked={events[e.id] ?? false}
          onChange={(v) => setEvents((prev) => ({ ...prev, [e.id]: v }))}
          label={e.label}
          hint={e.hint}
        />
      ))}

      <div class={s.setGroup}>Email (Resend)</div>
      <Field label="Resend API key" hint={data.resendKeySet ? `stored · ${data.resendKeyMasked}` : 'not set'}>
        <Input
          type="password"
          value={apiKey}
          placeholder={data.resendKeySet ? 'Leave blank to keep the stored key' : 're_…'}
          onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
        />
      </Field>
      <p class={s.setHint}>
        The stored key is never shown again. Leaving this blank keeps it; it is only replaced if you
        type a new one.
      </p>

      <Field label="From address">
        <Input value={from} placeholder="alerts@yourcompany.com" onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
      </Field>

      <Field label="Send to">
        <div class={s.chipRow}>
          {to.length === 0 && <span class={s.chipEmpty}>No recipients yet.</span>}
          {to.map((e) => (
            <span key={e} class={s.modelChip}>
              <span>{e}</span>
              <button type="button" aria-label={`Remove ${e}`} onClick={() => setTo((l) => l.filter((x) => x !== e))}><X size={11} /></button>
            </span>
          ))}
        </div>
      </Field>
      <div class={s.allowAdd}>
        <Input
          value={recipient}
          placeholder="ops@yourcompany.com"
          onInput={(e) => setRecip((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); addTo(); } }}
        />
        <Button size="sm" onClick={addTo} disabled={!validEmail || to.includes(recipient.trim())}>
          <Plus size={13} /> Add
        </Button>
      </div>
      {recipient.trim() && !validEmail && <p class={s.fieldWarn}>That doesn’t look like an email address.</p>}

      <div class={s.setGroup}>Webhook</div>
      <Field label="Webhook URL" hint="optional">
        <Input value={webhook} placeholder="https://hooks.example.com/nexus" onInput={(e) => setWebhook((e.target as HTMLInputElement).value)} />
      </Field>

      <div class={s.setGroup}>Noise control</div>
      <Field label="Don’t repeat the same alert within" hint="seconds · 60–86400">
        <Input type="number" min={60} max={86400} value={window} onInput={(e) => setWindow((e.target as HTMLInputElement).value)} />
      </Field>

      {enabled && !data.resendKeySet && !apiKey && !webhook.trim() && (
        <Badge tone="yellow">Alerts are on, but there is no email key and no webhook — nothing can be delivered</Badge>
      )}

      <SaveBar
        ctx={ctx}
        dirty={dirty}
        onSave={() => ctx.save({
          enabled, from, to, webhookUrl: webhook, events, windowSeconds,
          // Omit the key entirely when untouched, so an unrelated save never wipes it.
          ...(apiKey ? { resendApiKey: apiKey } : {}),
        })}
      />
    </>
  );
}
