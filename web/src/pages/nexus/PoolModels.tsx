import { useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { removeModelFromRegistry } from '../../lib/registry';
import type { AiModel } from '../../api';
import s from '../pages.module.css';

// The models a pool serves, shown inside Nexus (P7.4b folds the old Models tab in here). Each is a
// registry entry for this provider; removing one writes the trimmed registry back and asks the
// parent to reload. Models are added from the add-key "Fetch Models" step.
export function PoolModels({ models, onChanged }: { models: AiModel[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (id: string) => {
    setBusy(id);
    try { await removeModelFromRegistry(id); onChanged(); }
    catch { setBusy(null); }
  };

  return (
    <div class={s.poolModels}>
      <div class={s.poolModelsHead}>
        <span class={s.poolModelsLabel}>Models ({models.length})</span>
      </div>
      {models.length === 0
        ? <span class={s.poolModelsEmpty}>No models yet — add a key and fetch them.</span>
        : (
          <div class={s.modelChips}>
            {models.map((m) => (
              <span key={m.id} class={s.modelChip}>
                <span>{m.modelString}</span>
                <button type="button" onClick={() => remove(m.id)} disabled={busy !== null} aria-label={`Remove ${m.modelString}`}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
    </div>
  );
}
