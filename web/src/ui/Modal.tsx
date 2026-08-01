import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
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
 *
 * NOTE (P7.17d): `backdrop-filter` makes an element a containing block for `position: fixed`
 * descendants, so a dialog opened from inside a glass card had its "full-screen" overlay sized to
 * that card rather than the viewport — on a phone, wider than the screen. The fix is on the CSS
 * side (cards no longer carry the filter); a portal would have solved it too, but `preact/compat`
 * rewrites event semantics app-wide once imported, which is far too broad a change for this.
 */
export function Modal({ title, onClose, children, footer }: Props) {
  const titleId = useId();
  const dialogRef  = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // `onClose` is read through a ref so the effect below can call the CURRENT one without listing it
  // as a dependency. Every caller passes an inline arrow — `onClose={() => !saving && setDraft(null)}`
  // — which is a new function on every render, and that is the whole bug this ref exists to kill.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    // Move focus into the dialog on open and put it back on close. Without this a keyboard or
    // screen-reader user stays parked on whatever button opened the dialog, tabbing through the
    // page behind it while the dialog claims to be modal.
    //
    // The dependency list MUST stay empty: this is open/close behaviour, and it has to run once
    // when the dialog appears and once when it goes away. It used to depend on `onClose`, whose
    // identity changes on every render, so typing a single character into any field re-ran the
    // whole effect — the cleanup handed focus back to the button that opened the dialog and the
    // body moved it to the dialog shell, one keystroke in. Every text input in every dialog in the
    // dashboard was affected; each looked like its own small bug.
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      restoreRef.current?.focus();
    };
  }, []);

  return (
    // The overlay stays a div with role="presentation", NOT a <button> as one review suggested:
    // a button may not contain interactive content, and this one wraps a whole dialog of inputs —
    // that markup is invalid and browsers/AT handle it unpredictably. Backdrop click is a
    // mouse-only convenience; the keyboard route is Escape (above) and the labelled close button,
    // both of which already work, so no affordance is lost.
    <div class={s.modalOverlay} role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        class={s.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
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
