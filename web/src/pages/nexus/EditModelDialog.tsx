import { useEffect, useState } from 'preact/hooks';
import { Wand2 } from 'lucide-preact';
import { ApiError, type AiModel, type PricingCatalogEntry } from '../../api';
import { updateModelInRegistry } from '../../lib/registry';
import { loadPricingCatalog, matchCatalog } from '../../lib/catalog';
import { Modal, Field, Input, Select, FieldRow, Button, FormError, FormNote } from '../../ui';
import s from '../pages.module.css';

const CAPS = ['chat', 'completion', 'embedding', 'image', 'speech', 'transcription'] as const;
const TIERS = ['premium', 'standard', 'fast'] as const;
const STATUSES = ['active', 'paused', 'retired'] as const;

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

  useEffect(() => { loadPricingCatalog().then(setCatalog).catch(() => {}); }, []);

  const setN = (k: string, v: string) => setNum((p) => ({ ...p, [k]: v }));
  const toggleCap = (c: string) => setCaps((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const has = (c: string) => caps.includes(c);
  const hasText = has('chat') || has('completion') || has('embedding');

  const autofill = () => {
    const e = matchCatalog(catalog, model.modelString);
    if (!e) { setFilled('none'); return; }
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

  const submit = async (ev: Event) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const n = (k: string) => { const v = parseFloat(num[k]); return Number.isFinite(v) && v >= 0 ? v : 0; };
    const edited: AiModel = {
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
      contextWindow: Math.round(n('contextWindow')), maxTokens: Math.round(n('maxTokens')),
    };
    try {
      await updateModelInRegistry(edited);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the model.');
    } finally {
      setBusy(false);
    }
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
            : filled && <span class={s.editAutofillNote}>Filled from “{filled}”. Review before saving.</span>}
        </div>

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
