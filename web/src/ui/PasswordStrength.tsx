import { scorePassword } from '../lib/passwordStrength';
import s from './ui.module.css';

// The four-segment meter under a new-password field. Colour and fill track the score from
// passwordStrength — red at weak, amber at fair, green at strong. Renders nothing for an empty
// field so the form doesn't shout before the person has typed.
const TONE: Record<number, string> = { 1: 'var(--red)', 2: 'var(--orange)', 3: 'var(--yellow)', 4: 'var(--green)' };

export function PasswordStrength({ value }: { value: string }) {
  if (!value) return null;
  const { score, label } = scorePassword(value);
  const filled = Math.max(score, 1); // show at least one lit (red) bar once typing starts
  const color = TONE[score] ?? 'var(--red)';

  return (
    <div class={s.pwStrength}>
      <div class={s.pwBars} role="img" aria-label={`Password strength: ${label}`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} class={s.pwBar} style={{ background: i < filled ? color : undefined }} />
        ))}
      </div>
      <span class={s.pwStrengthLabel} style={{ color }}>{label}</span>
    </div>
  );
}
