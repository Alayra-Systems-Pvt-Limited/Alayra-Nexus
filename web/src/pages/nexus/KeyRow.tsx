import { useState } from 'preact/hooks';
import { POST, DEL, type NexusKeyHealth } from '../../api';
import { Badge, Button } from '../../ui';
import { EditKeyDialog } from './EditKeyDialog';
import { relativeTime } from '../../lib/format';
import { canWrite } from '../../lib/access';
import s from '../pages.module.css';

// One provider key: its masked value, owner (shared vs a BYOK team), live health, and the
// operator actions. Test probes the key upstream and reports inline; ban/unban/cool mutate and ask
// the parent to reload so the whole pool's health re-tallies.
function health(k: NexusKeyHealth): { tone: 'green' | 'yellow' | 'red'; label: string; cooling: boolean; banned: boolean } {
  const banned  = k.status === 'banned';
  const cooling = !banned && (k.status === 'cooling' || (!!k.coolingUntil && Date.parse(k.coolingUntil) > Date.now()));
  if (banned)  return { tone: 'red',    label: 'Banned',  cooling, banned };
  if (cooling) return { tone: 'yellow', label: 'Cooling', cooling, banned };
  return { tone: 'green', label: 'Active', cooling, banned };
}

export function KeyRow({ k, onChanged }: { k: NexusKeyHealth; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const h = health(k);

  const run = async (action: 'ban' | 'unban' | 'cool' | 'test' | 'delete') => {
    if (action === 'delete' && !confirm('Delete this key permanently?')) return;
    setBusy(action);
    setProbe(null);
    try {
      if (action === 'test') {
        const r = await POST<{ ok: boolean; latencyMs?: number; error?: string }>(`/admin/keys/${k.id}/test`);
        // Show the reason, not a bare "Failed" — "HTTP 401" and "timed out" call for different fixes.
        setProbe(r.ok ? `Reachable${r.latencyMs != null ? ` · ${r.latencyMs}ms` : ''}` : `Failed${r.error ? ` · ${r.error}` : ''}`);
      } else if (action === 'delete') {
        await DEL(`/admin/keys/${k.id}`);
        onChanged();
      } else {
        await POST(`/admin/keys/${k.id}/${action}`);
        onChanged();
      }
    } catch {
      setProbe('Action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class={s.keyRow}>
      <div class={s.keyMain}>
        <code class={s.keyMask}>{k.maskedKey}</code>
        {k.label && <span class={s.keyLabel}>{k.label}</span>}
        <Badge tone={k.ownerTeamName ? 'blue' : 'gray'}>{k.ownerTeamName ?? 'Shared'}</Badge>
      </div>
      <div class={s.keyMeta}>
        <Badge tone={h.tone} dot>{h.label}</Badge>
        <span class={s.keySub}>{k.rpmLimit}/min · {k.tpmLimit.toLocaleString()} tpm · {k.maxUsers.toLocaleString()} users{k.lastUsedAt ? ` · used ${relativeTime(k.lastUsedAt)}` : ''}</span>
        {probe && <span class={s.keyProbe}>{probe}</span>}
      </div>
      {canWrite() && (
        <div class={s.keyActions}>
          <Button size="sm" variant="ghost" onClick={() => run('test')} disabled={busy !== null}>Test</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy !== null}>Edit</Button>
          {!h.banned && !h.cooling && <Button size="sm" variant="ghost" onClick={() => run('cool')} disabled={busy !== null}>Cool</Button>}
          {(h.banned || h.cooling) && <Button size="sm" variant="ghost" onClick={() => run('unban')} disabled={busy !== null}>Restore</Button>}
          {!h.banned && <Button size="sm" variant="ghost" onClick={() => run('ban')} disabled={busy !== null}>Ban</Button>}
          <Button size="sm" variant="danger" onClick={() => run('delete')} disabled={busy !== null}>Delete</Button>
        </div>
      )}

      {editing && <EditKeyDialog k={k} onClose={() => setEditing(false)} onSaved={onChanged} />}
    </div>
  );
}
