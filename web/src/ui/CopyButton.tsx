import { useState, useRef, useEffect } from 'preact/hooks';
import { clsx } from 'clsx';
import { Copy, Check } from 'lucide-preact';
import { Button } from './Button';
import s from './ui.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface CopyButtonProps {
  /** The text to copy, when it is already in hand. */
  value?: string;
  /** Resolve the text at click time — for a credential the server reveals on demand, so it is
   *  fetched only when actually copied. Exactly one of `value` / `getValue` must be given. */
  getValue?: () => Promise<string>;
  /** Idle label. Omit for an icon-only button (then `ariaLabel` is required). */
  label?: string;
  /** Confirmation label. Defaults to "Copied". */
  copiedLabel?: string;
  iconOnly?: boolean;
  /** Required when iconOnly, so the control is still named for assistive tech. */
  ariaLabel?: string;
  variant?: Variant;
  size?: Size;
  class?: string;
  onCopied?: () => void;
  /** Surfaced when the clipboard write — or a `getValue` reveal — fails, so callers can show why. */
  onError?: (err: unknown) => void;
}

// The one copy control. Before it, nine call sites re-implemented "write to clipboard, flip to a
// tick for a moment, flip back" — and one (the team-key reveal) shipped with no feedback at all, so
// a click looked like nothing happened. This owns that behaviour once: the async `getValue` path
// covers reveal-then-copy without the caller re-inventing the confirmation, and the timer is
// cancelled on unmount so a copy just before a modal closes cannot set state on a gone component.
const RESET_MS = 1400;

export function CopyButton({
  value, getValue, label, copiedLabel = 'Copied', iconOnly = false, ariaLabel,
  variant = 'ghost', size = 'sm', class: cls, onCopied, onError,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      const text = getValue ? await getValue() : (value ?? '');
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onCopied?.();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), RESET_MS);
    } catch (err) {
      onError?.(err);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      icon={iconOnly}
      class={clsx(s.copyBtn, copied && s.copied, cls)}
      onClick={copy}
      // Only name the button when there is no visible text: an aria-label would otherwise pin the
      // accessible name to the idle word, so a screen reader would never hear the "Copied" flip.
      aria-label={iconOnly ? (ariaLabel ?? 'Copy') : undefined}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {!iconOnly && (copied ? copiedLabel : (label ?? 'Copy'))}
    </Button>
  );
}
