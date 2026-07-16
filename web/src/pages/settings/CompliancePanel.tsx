import { useState } from 'preact/hooks';
import { Toggle, Field, Input, FieldRow } from '../../ui';
import type { ComplianceConfig } from '../../api';
import { SettingsSection, SaveBar, type SaveCtx } from './SettingsSection';
import s from '../pages.module.css';

// Retention and anonymization. Both settings delete or obscure data that cannot be recovered, so the
// copy states the consequence in the same breath as the control — 0 is the dangerous value here and
// it is the one an operator is most likely to type by accident.
export function CompliancePanel() {
  return (
    <SettingsSection<ComplianceConfig>
      path="/admin/settings/compliance"
      title="Compliance & retention"
      description="How long Nexus keeps its records, and whether usage rows can be traced back to a session."
    >
      {(data, ctx) => <ComplianceForm data={data} ctx={ctx} />}
    </SettingsSection>
  );
}

function ComplianceForm({ data, ctx }: { data: ComplianceConfig; ctx: SaveCtx<ComplianceConfig> }) {
  const [audit, setAudit]   = useState(String(data.auditRetentionDays));
  const [usage, setUsage]   = useState(String(data.usageRetentionDays));
  const [notif, setNotif]   = useState(String(data.notificationRetentionDays));
  const [anon, setAnon]     = useState(data.anonymizeUsage);

  const auditDays = Math.max(0, parseInt(audit, 10) || 0);
  const usageDays = Math.max(0, parseInt(usage, 10) || 0);
  const notifDays = Math.max(0, parseInt(notif, 10) || 0);
  const dirty = auditDays !== data.auditRetentionDays || usageDays !== data.usageRetentionDays
    || notifDays !== data.notificationRetentionDays || anon !== data.anonymizeUsage;

  return (
    <>
      <FieldRow>
        <Field label="Keep audit entries for" hint="days · 0 = forever">
          <Input type="number" min={0} value={audit} onInput={(e) => setAudit((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Keep usage records for" hint="days · 0 = forever">
          <Input type="number" min={0} value={usage} onInput={(e) => setUsage((e.target as HTMLInputElement).value)} />
        </Field>
      </FieldRow>

      <Field label="Keep notifications for" hint="days · 0 = forever · shorter than the others by default">
        <Input type="number" min={0} value={notif} onInput={(e) => setNotif((e.target as HTMLInputElement).value)} />
      </Field>
      <p class={s.setHint}>
        How long alerts stay in the notifications bell. They are operational noise rather than a
        record — the audit trail is what testifies to what happened — so they default to a shorter
        window.
      </p>

      <p class={s.warnNote}>
        <b>Deletion is permanent.</b> Anything past the retention window is removed by the cleanup job
        and cannot be recovered — including the usage rows your cost and analytics figures are
        calculated from. Set a value to <b>0</b> to keep records indefinitely.
      </p>

      <Toggle
        checked={anon}
        onChange={setAnon}
        label="Anonymize usage records"
        hint="Replaces the session fingerprint with a one-way hash. Per-session grouping still works; the original value is never stored."
      />

      <SaveBar
        ctx={ctx}
        dirty={dirty}
        onSave={() => ctx.save({
          auditRetentionDays: auditDays, usageRetentionDays: usageDays,
          notificationRetentionDays: notifDays, anonymizeUsage: anon,
        })}
      />
    </>
  );
}
