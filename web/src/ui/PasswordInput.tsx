import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { clsx } from 'clsx';
import { Eye, EyeOff } from 'lucide-preact';
import s from './ui.module.css';

// The one password field. Before it, every password input across claim / invite / recover / sign-in
// was a bare `<input type="password">` with no way to reveal what you typed — punishing on a long
// passphrase you can't see. This owns the reveal toggle once (the CopyButton precedent): a ghost
// eye button that flips the input between password and text, named for assistive tech.
type Props = Omit<JSX.IntrinsicElements['input'], 'type'>;

export function PasswordInput({ class: cls, ...props }: Props) {
  const [show, setShow] = useState(false);
  return (
    <div class={s.pwWrap}>
      <input
        type={show ? 'text' : 'password'}
        class={clsx(s.input, s.pwInput, cls)}
        {...props}
      />
      <button
        type="button"
        class={s.pwEye}
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}
