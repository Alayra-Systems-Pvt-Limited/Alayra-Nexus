import { useState } from 'preact/hooks';
import { Pencil, X, Plus } from 'lucide-preact';
import { removeModelFromRegistry } from '../../lib/registry';
import { canWrite } from '../../lib/access';
import type { AiModel, NexusPool } from '../../api';
import { EditModelDialog } from './EditModelDialog';
import { AddModelsDialog } from './AddModelsDialog';
import s from '../pages.module.css';

// The models a pool serves, shown inside Nexus (P7.4b folded the old Models tab in here; P7.4c made
// each one editable). Every row shows what the model does and its headline price; Edit opens the
// capability-driven detail editor, and × removes it from the registry.
//
// "Add models" closes the hole those two left: models could only be chosen while a key was being
// added, so the list was frozen the moment the pool was created and growing it meant deleting the
// pool — throwing away a working credential to edit a list unrelated to it. See AddModelsDialog.
function priceSummary(m: AiModel): string {
  if (m.inputCostPer1M || m.outputCostPer1M) return `$${m.inputCostPer1M} / $${m.outputCostPer1M} per 1M`;
  if (m.audioInputPer1M || m.audioOutputPer1M) return `audio $${m.audioInputPer1M} / $${m.audioOutputPer1M} per 1M`;
  if (m.speechPricePer1MChars) return `$${m.speechPricePer1MChars} / 1M chars`;
  if (m.transcriptionPrice) return `$${m.transcriptionPrice} / file`;
  if (m.imagePrice) return `$${m.imagePrice} / image`;
  return 'Unpriced';
}

export function PoolModels({ pool, models, onChanged }: { pool: NexusPool; models: AiModel[]; onChanged: () => void }) {
  const [busy, setBusy]     = useState<string | null>(null);
  const [editing, setEditing] = useState<AiModel | null>(null);
  const [adding, setAdding]   = useState(false);

  const remove = async (id: string) => {
    setBusy(id);
    try { await removeModelFromRegistry(id); onChanged(); }
    catch { /* leave the list as-is; the button re-enables in finally */ }
    finally { setBusy(null); }
  };

  return (
    <div class={s.poolModels}>
      <div class={s.poolModelsHead}>
        <span class={s.poolModelsLabel}>Models ({models.length})</span>
        {canWrite() && (
          <button type="button" class={s.poolModelsAdd} onClick={() => setAdding(true)} disabled={busy !== null}>
            <Plus size={12} /> Add models
          </button>
        )}
      </div>
      {models.length === 0
        ? <span class={s.poolModelsEmpty}>No models yet — add a key, then add models.</span>
        : (
          <div class={s.modelList}>
            {models.map((m) => (
              <div key={m.id} class={s.modelItem}>
                <div class={s.modelItemMain}>
                  <span class={s.modelItemName}>{m.modelString}</span>
                  <span class={s.modelItemMeta}>{m.capabilities.join(' · ')} · {priceSummary(m)}</span>
                </div>
                {canWrite() && (
                  <div class={s.modelItemActions}>
                    <button type="button" class={s.modelItemBtn} onClick={() => setEditing(m)} disabled={busy !== null} aria-label={`Edit ${m.modelString}`}><Pencil size={12} /></button>
                    <button type="button" class={s.modelItemBtn} onClick={() => remove(m.id)} disabled={busy !== null} aria-label={`Remove ${m.modelString}`}><X size={13} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

      {editing && <EditModelDialog model={editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
      {adding && <AddModelsDialog pool={pool} existing={models} onClose={() => setAdding(false)} onAdded={onChanged} />}
    </div>
  );
}
