import { useEffect, useState } from 'preact/hooks';
import { fetchProviderModels, ApiError, type FetchedModel, type AiModel, type NexusPool } from '../../api';
import { addModelsToRegistry, type RegistryModelInput } from '../../lib/registry';
import { Modal, Field, Button, FormError, FormNote, Spinner } from '../../ui';
import { ModelPicker } from './ModelPicker';

/**
 * Add models to a pool that already exists.
 *
 * Until this dialog, models could only ever be chosen in the one moment a key was being added, so a
 * pool's model list was fixed the instant it was created. Adding a second model meant deleting the
 * pool and rebuilding it — discarding a working, encrypted credential to change a list that has
 * nothing to do with it.
 *
 * No key is asked for. `POST /admin/providers/:id/fetch-models` already falls back to decrypting an
 * active key on the pool when no plaintext one is supplied (nexus.service.ts), so the gateway can
 * ask the provider on its own behalf. The capability was there the whole time with nothing calling
 * it.
 *
 * Models already in the registry are filtered out rather than shown pre-selected: this dialog only
 * adds, and offering a checked box that cannot be unchecked would imply a removal that lives
 * elsewhere (the × on each row).
 */
export function AddModelsDialog({ pool, existing, onClose, onAdded }: {
  pool: NexusPool;
  existing: AiModel[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [fetched, setFetched]   = useState<FetchedModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Fetch on open. There is nothing to type first, so making the operator press a second button
  // would be ceremony — the dialog's whole purpose is "show me what else this provider has".
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetchProviderModels(pool.id);
        if (!live) return;
        setFetched(r.models);
      } catch (err) {
        if (!live) return;
        // The gateway says "add an active key to this pool first" when it has nothing to decrypt,
        // which is the actionable case — so its message is shown rather than replaced.
        setError(err instanceof ApiError ? err.message : 'Could not fetch models from this provider.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [pool.id]);

  const already   = new Set(existing.map((m) => m.modelString));
  const available = fetched.filter((m) => !already.has(m.id));

  // How many of the CURRENT selection will land with no price at all.
  //
  // A model arrives priced only if its provider published a figure — OpenRouter and Groq do, most
  // do not — and an unpriced model reports $0 for every request forever. The operator has to be
  // told, but not one dialog at a time: selecting 40 OpenRouter models would mean 40 interruptions,
  // and a prompt that fires that often stops being read. So it is one running count, shown while
  // the selection can still be changed, and the per-model nag lives in the editor instead.
  //
  // `!== undefined`, not truthiness: a published 0 is a real price (OpenRouter's `:free` models).
  const byId = new Map(fetched.map((m) => [m.id, m]));
  const unpricedSelected = selected.filter((id) => {
    const m = byId.get(id);
    return m?.inputCostPer1M === undefined && m?.outputCostPer1M === undefined;
  }).length;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!selected.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const inputs: RegistryModelInput[] = selected.map((id) => {
        const m = byId.get(id);
        return {
          modelString: id,
          displayName: m?.name,
          inputCostPer1M: m?.inputCostPer1M,
          outputCostPer1M: m?.outputCostPer1M,
          contextWindow: m?.contextWindow,
        };
      });
      await addModelsToRegistry(pool.provider, pool.tier, inputs);
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the models.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Add models · ${pool.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!selected.length || busy}>
            {busy ? 'Adding…' : selected.length ? `Add ${selected.length} model${selected.length === 1 ? '' : 's'}` : 'Add models'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <FormError>{error}</FormError>}

        {loading && <FormNote><Spinner /> Asking {pool.provider} what it serves, using this pool's stored key…</FormNote>}

        {!loading && !error && available.length === 0 && fetched.length > 0 && (
          <FormNote>Every model {pool.provider} returns is already in this pool.</FormNote>
        )}

        {!loading && available.length > 0 && (
          <>
            {already.size > 0 && (
              <FormNote>
                {already.size} model{already.size === 1 ? ' is' : 's are'} already in this pool and {already.size === 1 ? 'is' : 'are'} not listed again.
              </FormNote>
            )}
            <Field
              label={`Models (${selected.length}/${available.length} selected)`}
              hint="click to select — only selected models join the registry"
            >
              <ModelPicker models={available} selected={selected} onChange={setSelected} />
            </Field>

            {unpricedSelected > 0 && (
              <FormNote>
                <b>{unpricedSelected} of the {selected.length} selected</b> {unpricedSelected === 1 ? 'has' : 'have'} no
                price from {pool.provider}. {unpricedSelected === 1 ? 'It' : 'They'} will route normally, but
                report <b>$0</b> in Analytics until you set a price — each model row has a “No price” badge and an
                editor for it.
              </FormNote>
            )}
          </>
        )}

        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
