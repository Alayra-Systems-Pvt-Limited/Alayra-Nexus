import type { ComponentChildren } from 'preact';
import { useEffect, useId } from 'preact/hooks';
import { X } from 'lucide-preact';
import s from './ui.module.css';

interface Props {
  title:    string;
  onClose:  () => void;
  children: ComponentChildren;
  /** Footer actions (e.g. Cancel / Save). Rendered in a sticky-bottom bar. */
  footer?:  ComponentChildren;
}

/**
 * A focus-trapping-free but keyboard-dismissable dialog. Escape and an overlay click both close it;
 * body scroll is locked while open. Deliberately minimal — it's the shell every form dialog (add
 * key, add provider, and the budgeting/settings dialogs to come) is poured into.
 */
export function Modal({ title, onClose, children, footer }: Props) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div class={s.modalOverlay} onClick={onClose}>
      <div class={s.modal} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div class={s.modalHead}>
          <h2 id={titleId} class={s.modalTitle}>{title}</h2>
          <button type="button" class={s.modalClose} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div class={s.modalBody}>{children}</div>
        {footer && <div class={s.modalFoot}>{footer}</div>}
      </div>
    </div>
  );
}
