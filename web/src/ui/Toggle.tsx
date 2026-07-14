import { clsx } from 'clsx';
import s from './ui.module.css';

// A labelled on/off switch. Every operator setting in the gateway is a boolean with a consequence,
// so the control carries its own description rather than leaving the meaning to a bare label — an
// operator should never have to guess what turning something on will actually do.
//
// The wrapper is a <div>, deliberately NOT a <label>. A <button> is a labelable element, so a
// surrounding <label> re-dispatches the click to it — the switch fires twice and lands back where it
// started, i.e. it silently does nothing. The row handles the click once; the button carries the
// role, the state, and the keyboard affordance (Enter/Space raise a click that bubbles here).
interface Props {
  checked:  boolean;
  onChange: (next: boolean) => void;
  label:    string;
  hint?:    string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, hint, disabled }: Props) {
  const flip = () => { if (!disabled) onChange(!checked); };
  return (
    <div class={clsx(s.toggleRow, disabled && s.toggleDisabled)} onClick={flip}>
      <span class={s.toggleText}>
        <span class={s.toggleLabel}>{label}</span>
        {hint && <span class={s.toggleHint}>{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        class={clsx(s.toggle, checked && s.toggleOn)}
      >
        <span class={s.toggleKnob} />
      </button>
    </div>
  );
}
