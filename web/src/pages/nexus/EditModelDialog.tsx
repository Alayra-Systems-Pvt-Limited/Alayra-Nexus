import { useEffect, useState } from 'preact/hooks';
import { Wand2, AlertTriangle } from 'lucide-preact';
import { ApiError, type AiModel, type PricingCatalogEntry, type PricingSource } from '../../api';
import { updateModelInRegistry } from '../../lib/registry';
import { loadPricingCatalog, matchPricing } from '../../lib/catalog';
import { pricingSourceOf } from '../../lib/pricing';
import { Modal, Field, Input, Select, FieldRow, Button, FormError, FormNote } from '../../ui';
import s from '../pages.module.css';

const CAPS = ['chat', 'completion', 'embedding', 'image', 'speech', 'transcription'] as const;
const TIERS = ['premium', 'standard', 'fast'] as const;
const STATUSES = ['active', 'paused', 'retired'] as const;

// Every field that is a price. Editing one of these by hand is what makes a model's pricing
// `manual` — the operator's own figure, which nothing else may later overwrite.
const PRICE_KEYS = [
  'inputCostPer1M', 'outputCostPer1M', 'imagePrice', 'speechPricePer1MChars',
  'transcriptionPrice', 'audioInputPer1M', 'audioOutputPer1M',
] as const;

// Editable model detail. Reuses the validated PUT /admin/models registry write. The pricing boxes
// shown are driven by the model's capabilities — you only ever see prices that apply — and
// "Auto-fill" seeds them from the bundled catalog (indicative; always confirm before saving).
export function EditModelDialog({ model, onClose, onSaved }: { model: AiModel; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(model.displayName || model.modelString);
  const [tier, setTier]       = useState(model.tier);
  const [status, setStatus]   = useState(model.status);
  const [priority, setPriority] = useState(String(model.priority ?? 1));
  const [caps, setCaps]       = useState<string[]>(model.capabilities.length ? model.capabilities : ['chat']);
  const [vision, setVision]   = useState(model.hasVision);
  const [tools, setTools]     = useState(model.hasToolCalling);
  const [num, setNum] = useState<Record<string, string>>({
    inputCostPer1M:        String(model.inputCostPer1M ?? 0),
    outputCostPer1M:       String(model.outputCostPer1M ?? 0),
    imagePrice:            String(model.imagePrice ?? 0),
    speechPricePer1MChars: String(model.speechPricePer1MChars ?? 0),
    transcriptionPrice:    String(model.transcriptionPrice ?? 0),
    audioInputPer1M:       String(model.audioInputPer1M ?? 0),
    audioOutputPer1M:      String(model.audioOutputPer1M ?? 0),
    contextWindow:         String(model.contextWindow ?? 0),
    maxTokens:             String(model.maxTokens ?? 0),
  });
  const [catalog, setCatalog] = useState<PricingCatalogEntry[]>([]);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [filled, setFilled]   = useState<string | null>(null);
  // Provenance of the prices currently in the form, carried through the edit so saving cannot
  // silently launder a catalog guess into an operator-confirmed figure (or the reverse).
  const [source, setSource]   = useState<PricingSource>(pricingSourceOf(model));
  const [borrowed, setBorrowed] = useState<string | null>(null);
  const [confirmUnpriced, setConfirmUnpriced] = useState(false);

  useEffect(() => { loadPricingCatalog().then(setCatalog).catch(() => {}); }, []);

  const setN = (k: string, v: string) => {
    setNum((p) => ({ ...p, [k]: v }));
    // Typing in a price box is the operator taking ownership of the number.
    if ((PRICE_KEYS as readonly string[]).includes(k)) {
      setSource('manual');
      setBorrowed(null);
      setFilled(null);
      setConfirmUnpriced(false);
    }
  };
  const toggleCap = (c: string) => setCaps((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const has = (c: string) => caps.includes(c);
  const hasText = has('chat') || has('completion') || has('embedding');

  const autofill = () => {
    // Matched against this pool's own provider: a catalog entry from a DIFFERENT provider is still
    // offered (a nearby figure beats an empty box) but is reported as borrowed, because providers
    // charge differently for the same model and a silent fill would look authoritative.
    const hit = matchPricing(catalog, model.modelString, model.provider);
    if (!hit) { setFilled('none'); return; }
    const e = hit.entry;
    setSource('catalog');
    setBorrowed(hit.crossProvider ? e.provider : null);
    setConfirmUnpriced(false);
    if (e.capabilities?.length) setCaps(e.capabilities);
    if (e.hasVision !== undefined) setVision(e.hasVision);
    if (e.hasToolCalling !== undefined) setTools(e.hasToolCalling);
    setNum((p) => {
      const next = { ...p };
      const keys: (keyof PricingCatalogEntry)[] = [
        'inputCostPer1M', 'outputCostPer1M', 'imagePrice', 'speechPricePer1MChars',
        'transcriptionPrice', 'audioInputPer1M', 'audioOutputPer1M', 'contextWindow', 'maxTokens',
      ];
      for (const k of keys) if (e[k] !== undefined) next[k] = String(e[k]);
      return next;
    });
    setFilled(e.displayName);
  };

  const n = (k: string) => { const v = parseFloat(num[k]); return Number.isFinite(v) && v >= 0 ? v : 0; };

  /** The provenance this save should record. A price typed into the form always wins, even if the
   *  edit began from a catalog fill — the operator looked at it and kept it. */
  const resolvedSource = (): PricingSource =>
    (source === 'unset' && PRICE_KEYS.some((k) => n(k) > 0)) ? 'manual' : source;

  const build = (): AiModel => ({
    ...model,
    displayName: displayName.trim() || model.modelString,
    tier, status,
    priority: Math.max(1, parseInt(priority, 10) || 1),
    capabilities: caps.length ? caps : ['chat'],
    hasVision: vision, hasToolCalling: tools,
    inputCostPer1M: n('inputCostPer1M'), outputCostPer1M: n('outputCostPer1M'),
    imagePrice: n('imagePrice'), speechPricePer1MChars: n('speechPricePer1MChars'),
    transcriptionPrice: n('transcriptionPrice'),
    audioInputPer1M: n('audioInputPer1M'), audioOutputPer1M: n('audioOutputPer1M'),
    pricingSource: resolvedSource(),
    contextWindow: Math.round(n('contextWindow')), maxTokens: Math.round(n('maxTokens')),
  });

  const persist = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateModelInRegistry(build());
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the model.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    // Saving a model nobody has priced is allowed — a free endpoint or a local runtime has no
    // price to give — but it is never allowed to happen silently, because the consequence lands
    // somewhere the operator is not looking: every request through this model reports $0.
    if (resolvedSource() === 'unset' && !confirmUnpriced) { setConfirmUnpriced(true); return; }
    await persist();
  };

  return (
    <Modal
      title={`Edit model · ${model.modelString}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-model-form" disabled={busy}>{busy ? 'Saving…' : 'Save model'}</Button>
        </>
      }
    >
      <form id="edit-model-form" onSubmit={submit}>
        {error && <FormError>{error}</FormError>}

        <div class={s.editAutofill}>
          <Button variant="secondary" onClick={autofill}><Wand2 size={13} /> Auto-fill pricing</Button>
          {filled === 'none'
            ? <span class={s.editAutofillNote}>No catalog match — enter values manually.</span>
            : filled && (
              borrowed
                ? <span class={s.editAutofillWarn}>
                    Filled from {borrowed}&rsquo;s price for &ldquo;{filled}&rdquo;. {model.provider} may charge
                    a different rate — confirm before saving.
                  </span>
                : <span class={s.editAutofillNote}>Filled from &ldquo;{filled}&rdquo;. Review before saving.</span>
            )}
        </div>

        {confirmUnpriced && (
          <div class={s.unpricedConfirm} role="alert">
            <AlertTriangle size={15} class={s.unpricedIcon} />
            <div class={s.unpricedBody}>
              <strong>{model.provider} doesn&rsquo;t publish a price for this model.</strong>
              <span>Without one, every request through it reports $0 and your cost analytics under-report.</span>
            </div>
            <div class={s.unpricedActions}>
              <Button variant="ghost" onClick={() => setConfirmUnpriced(false)} disabled={busy}>Set pricing</Button>
              <Button variant="secondary" onClick={persist} disabled={busy}>{busy ? 'Saving…' : 'Save anyway'}</Button>
            </div>
          </div>
        )}

        <FieldRow>
          <Field label="Display name"><Input value={displayName} onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)} /></Field>
          <Field label="Priority" hint="lower tried first"><Input type="number" min={1} value={priority} onInput={(e) => setPriority((e.target as HTMLInputElement).value)} /></Field>
        </FieldRow>
        <FieldRow>
          <Field label="Tier"><Select value={tier} onChange={(e) => setTier((e.target as HTMLSelectElement).value)}>{TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
          <Field label="Status"><Select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>{STATUSES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
        </FieldRow>

        <Field label="Capabilities" hint="what this model can do">
          <div class={s.capToggles}>
            {CAPS.map((c) => (
              <button type="button" key={c} class={`${s.capToggle} ${has(c) ? s.capToggleOn : ''}`} onClick={() => toggleCap(c)}>{c}</button>
            ))}
            <button type="button" class={`${s.capToggle} ${vision ? s.capToggleOn : ''}`} onClick={() => setVision((v) => !v)}>vision</button>
            <button type="button" class={`${s.capToggle} ${tools ? s.capToggleOn : ''}`} onClick={() => setTools((v) => !v)}>tools</button>
          </div>
        </Field>

        {hasText && (
          <>
            <FieldRow>
              <Field label="Input price" hint="$ / 1M tokens"><Input type="number" min={0} step="any" value={num.inputCostPer1M} onInput={(e) => setN('inputCostPer1M', (e.target as HTMLInputElement).value)} /></Field>
              <Field label="Output price" hint="$ / 1M tokens"><Input type="number" min={0} step="any" value={num.outputCostPer1M} onInput={(e) => setN('outputCostPer1M', (e.target as HTMLInputElement).value)} /></Field>
            </FieldRow>
            <FieldRow>
              <Field label="Context window" hint="max input tokens"><Input type="number" min={0} value={num.contextWindow} onInput={(e) => setN('contextWindow', (e.target as HTMLInputElement).value)} /></Field>
              <Field label="Max output" hint="tokens"><Input type="number" min={0} value={num.maxTokens} onInput={(e) => setN('maxTokens', (e.target as HTMLInputElement).value)} /></Field>
            </FieldRow>
          </>
        )}

        {has('image') && (
          <Field label="Image price" hint="$ / image"><Input type="number" min={0} step="any" value={num.imagePrice} onInput={(e) => setN('imagePrice', (e.target as HTMLInputElement).value)} /></Field>
        )}

        {has('speech') && (
          <>
            <Field label="Speech price" hint="$ / 1M input characters (classic TTS)"><Input type="number" min={0} step="any" value={num.speechPricePer1MChars} onInput={(e) => setN('speechPricePer1MChars', (e.target as HTMLInputElement).value)} /></Field>
            <FormNote>Realtime/omni audio models bill audio as tokens per direction — fill these too if applicable:</FormNote>
            <FieldRow>
              <Field label="Audio input" hint="$ / 1M tokens"><Input type="number" min={0} step="any" value={num.audioInputPer1M} onInput={(e) => setN('audioInputPer1M', (e.target as HTMLInputElement).value)} /></Field>
              <Field label="Audio output" hint="$ / 1M tokens"><Input type="number" min={0} step="any" value={num.audioOutputPer1M} onInput={(e) => setN('audioOutputPer1M', (e.target as HTMLInputElement).value)} /></Field>
            </FieldRow>
          </>
        )}

        {has('transcription') && (
          <Field label="Transcription price" hint="$ / file (or per minute)"><Input type="number" min={0} step="any" value={num.transcriptionPrice} onInput={(e) => setN('transcriptionPrice', (e.target as HTMLInputElement).value)} /></Field>
        )}
      </form>
    </Modal>
  );
}
