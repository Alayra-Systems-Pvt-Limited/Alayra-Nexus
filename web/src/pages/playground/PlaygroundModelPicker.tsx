import { Check, ChevronDown, Search, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PlaygroundModel } from '../../lib/playground';
import s from './playground.module.css';

interface Props {
  models: PlaygroundModel[];
  selectedIds: string[];
  disabled?: boolean;
  max?: number;
  onToggle(id: string): void;
}

export function PlaygroundModelPicker({ models, selectedIds, disabled = false, max = 4, onToggle }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement | null>(null);
  const atLimit = selectedIds.length >= max;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) =>
      (model.displayName + ' ' + model.provider + ' ' + model.id).toLowerCase().includes(needle));
  }, [models, query]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div class={s.modelPicker} ref={root}>
      <span class={s.controlLabel}>Models <small>{max} max</small></span>
      <button type="button" class={s.modelPickerTrigger} aria-haspopup="dialog" aria-expanded={open}
        aria-controls="playground-model-picker" disabled={disabled} onClick={() => setOpen((value) => !value)}>
        <span>{selectedIds.length} models selected</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div id="playground-model-picker" class={s.modelPickerMenu} role="dialog" aria-label="Select comparison models">
          <label class={s.modelSearch}>
            <Search size={14} />
            <input autoFocus value={query} placeholder="Search models" aria-label="Search models"
              onInput={(event) => setQuery(event.currentTarget.value)} />
            {query && <button type="button" aria-label="Clear model search" onClick={() => setQuery('')}><X size={13} /></button>}
          </label>
          <div class={s.modelPickerList}>
            {filtered.map((model) => {
              const chosen = selectedIds.includes(model.id);
              const unavailable = !chosen && atLimit;
              return (
                <label class={unavailable ? s.modelPickerOptionDisabled : s.modelPickerOption} key={model.id}>
                  <input type="checkbox" checked={chosen} disabled={unavailable} onChange={() => onToggle(model.id)} />
                  <span class={chosen ? s.pickerCheckActive : s.pickerCheck}>{chosen && <Check size={11} />}</span>
                  <span><strong>{model.auto ? 'Nexus Auto' : model.displayName}</strong><small>{model.provider}</small></span>
                </label>
              );
            })}
            {filtered.length === 0 && <div class={s.modelPickerEmpty}>No models match "{query}".</div>}
          </div>
          <div class={s.modelPickerFoot}>
            <span>Select 2-{max} models</span>
            {atLimit && <strong>Maximum {max} models</strong>}
          </div>
        </div>
      )}
    </div>
  );
}
