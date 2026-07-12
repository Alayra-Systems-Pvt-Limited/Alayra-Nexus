import { useState } from 'preact/hooks';
import { Plus, Trash2 } from 'lucide-preact';
import { Card, Badge, Button, EmptyState } from '../../ui';
import { DEL, type NexusPool, type AiModel } from '../../api';
import { KeyRow } from './KeyRow';
import { PoolModels } from './PoolModels';
import { AddKeyDialog } from './AddKeyDialog';
import s from '../pages.module.css';

// One provider pool: its identity, the keys that serve it, the models it exposes (folded in from the
// old Models tab), and the operator actions to add a key or remove the whole pool. Each key's own
// actions are delegated to KeyRow; model chips to PoolModels.
export function PoolCard({ pool, models, onChanged }: { pool: NexusPool; models: AiModel[]; onChanged: () => void }) {
  const [addingKey, setAddingKey] = useState(false);
  const [removing, setRemoving]   = useState(false);

  const removePool = async () => {
    if (!confirm(`Remove the “${pool.name}” pool and all its keys? This cannot be undone.`)) return;
    setRemoving(true);
    try { await DEL(`/admin/providers/${pool.id}`); onChanged(); }
    catch { setRemoving(false); }
  };

  return (
    <Card>
      <div class={s.poolHead}>
        <div>
          <div class={s.poolName}>{pool.name}</div>
          <div class={s.poolSub}>
            <Badge tone="gray">{pool.provider}</Badge>
            {pool.preferredModel && <span class={s.poolModel}>{pool.preferredModel}</span>}
          </div>
        </div>
        <div class={s.poolHeadActions}>
          <span class={s.poolCount}>{pool.keys.length} key{pool.keys.length === 1 ? '' : 's'}</span>
          <Button size="sm" variant="ghost" onClick={() => setAddingKey(true)}><Plus size={14} /> Key</Button>
          <Button size="sm" variant="ghost" icon onClick={removePool} disabled={removing} aria-label="Remove pool"><Trash2 size={14} /></Button>
        </div>
      </div>

      {pool.keys.length === 0
        ? <EmptyState>No keys in this pool yet</EmptyState>
        : <div class={s.keyList}>{pool.keys.map((k) => <KeyRow key={k.id} k={k} onChanged={onChanged} />)}</div>}

      <PoolModels models={models} onChanged={onChanged} />

      {addingKey && (
        <AddKeyDialog
          providerId={pool.id}
          providerName={pool.name}
          provider={pool.provider}
          tier={pool.tier}
          onClose={() => setAddingKey(false)}
          onChanged={onChanged}
        />
      )}
    </Card>
  );
}
