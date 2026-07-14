import { useState } from 'preact/hooks';
import { Trash2, Plus } from 'lucide-preact';
import { Toggle, Input, Select, Button, Badge } from '../../ui';
import type { GuardrailConfig, GuardrailRule } from '../../api';
import { SettingsSection, SaveBar, type SaveCtx } from './SettingsSection';
import s from '../pages.module.css';

// Content guardrails: patterns that block or redact text on its way in or out. The pattern is a
// regular expression, and a broken one is rejected by the gateway at save time rather than silently
// skipped — so the panel checks it as you type and tells you before you try.
const BLANK: GuardrailRule = { name: '', pattern: '', flags: 'gi', action: 'redact', appliesTo: 'both', replacement: '[redacted]' };

const badPattern = (r: GuardrailRule): boolean => {
  if (!r.pattern) return false;
  try { new RegExp(r.pattern, r.flags || 'gi'); return false; } catch { return true; }
};

export function GuardrailsPanel() {
  return (
    <SettingsSection<GuardrailConfig>
      path="/admin/settings/guardrails"
      title="Guardrails"
      description="Patterns that block or redact content passing through the gateway. Off by default — nothing is inspected until you turn this on."
    >
      {(data, ctx) => <GuardrailsForm data={data} ctx={ctx} />}
    </SettingsSection>
  );
}

function GuardrailsForm({ data, ctx }: { data: GuardrailConfig; ctx: SaveCtx<GuardrailConfig> }) {
  const [enabled, setEnabled]   = useState(data.enabled);
  const [buffered, setBuffered] = useState(data.bufferedSafe);
  const [rules, setRules]       = useState<GuardrailRule[]>(data.rules);

  const dirty = enabled !== data.enabled || buffered !== data.bufferedSafe
    || JSON.stringify(rules) !== JSON.stringify(data.rules);

  const invalid  = rules.some(badPattern);
  const unnamed  = rules.some((r) => !r.name.trim() || !r.pattern.trim());
  const blocked  = invalid || unnamed;

  const update = (i: number, patch: Partial<GuardrailRule>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      <Toggle checked={enabled} onChange={setEnabled} label="Inspect content" hint="When off, no rule below runs and nothing is examined." />
      <Toggle
        checked={buffered}
        onChange={setBuffered}
        label="Also filter streamed replies"
        hint="A streamed reply can only be checked by collecting it first, which delays the first word. Off means streams are sent through unfiltered — never silently, the response says so."
      />

      <div class={s.ruleList}>
        {rules.length === 0 && <p class={s.setHint}>No rules yet. Add one below.</p>}
        {rules.map((r, i) => (
          <div class={s.ruleItem} key={i}>
            <div class={s.ruleGrid}>
              <Input value={r.name} placeholder="Rule name" onInput={(e) => update(i, { name: (e.target as HTMLInputElement).value })} />
              <Input
                value={r.pattern}
                placeholder="regular expression"
                class={badPattern(r) ? s.inputBad : undefined}
                onInput={(e) => update(i, { pattern: (e.target as HTMLInputElement).value })}
              />
              <Select value={r.action} onChange={(e) => update(i, { action: (e.target as HTMLSelectElement).value as GuardrailRule['action'] })}>
                <option value="redact">Redact</option>
                <option value="block">Block</option>
              </Select>
              <Select value={r.appliesTo ?? 'both'} onChange={(e) => update(i, { appliesTo: (e.target as HTMLSelectElement).value as GuardrailRule['appliesTo'] })}>
                <option value="both">Input & output</option>
                <option value="input">Input only</option>
                <option value="output">Output only</option>
              </Select>
              <button type="button" class={s.headerRowDel} aria-label={`Remove rule ${i + 1}`} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
            {badPattern(r) && <p class={s.fieldWarn}>That is not a valid regular expression — the gateway will refuse to save it.</p>}
            {r.action === 'redact' && (
              <Input
                value={r.replacement ?? ''}
                placeholder="[redacted]"
                onInput={(e) => update(i, { replacement: (e.target as HTMLInputElement).value })}
              />
            )}
          </div>
        ))}
      </div>

      <Button size="sm" onClick={() => setRules((rs) => [...rs, { ...BLANK }])} disabled={rules.length >= 100}>
        <Plus size={13} /> Add rule
      </Button>

      {enabled && rules.length === 0 && (
        <p class={s.warnNote}>Guardrails are on but no rules are defined, so nothing is being filtered.</p>
      )}
      {blocked && <Badge tone="red">Fix the rules above before saving</Badge>}

      <SaveBar
        ctx={ctx}
        dirty={dirty && !blocked}
        onSave={() => ctx.save({ enabled, bufferedSafe: buffered, rules })}
      />
    </>
  );
}
