import { Sun, Moon } from 'lucide-preact';
import { Card } from '../../ui';
import { useTheme, setTheme, type Theme } from '../../theme';
import { BrandingCard } from './BrandingCard';
import s from '../pages.module.css';

// Appearance holds the two "how this looks" settings, and they are deliberately different in kind:
// the theme lives in this browser and applies instantly (no Save button to pretend otherwise), while
// branding (P7.11) is a gateway setting everyone sees and therefore has one. Each card says which.
const OPTIONS: { id: Theme; label: string; hint: string; icon: preact.JSX.Element }[] = [
  { id: 'dark',  label: 'Dark',  hint: 'Softened slate — the default.',        icon: <Moon size={15} /> },
  { id: 'light', label: 'Light', hint: 'Bright, for well-lit rooms.',          icon: <Sun size={15} /> },
];

export function AppearancePanel() {
  return (
    <>
      <ThemeCard />
      <BrandingCard />
    </>
  );
}

function ThemeCard() {
  const { theme } = useTheme();
  return (
    <Card heading="Appearance">
      <p class={s.setDesc}>How this dashboard looks. Saved in this browser and applied immediately — it is not a gateway setting, so it does not affect anyone else.</p>
      <div class={s.themeGrid}>
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={theme === o.id}
            class={`${s.themeOpt} ${theme === o.id ? s.themeOptOn : ''}`}
            onClick={() => setTheme(o.id)}
          >
            <span class={s.themeIcon}>{o.icon}</span>
            <span class={s.themeName}>{o.label}</span>
            <span class={s.themeHint}>{o.hint}</span>
          </button>
        ))}
      </div>
      <p class={s.setHint}>Both themes are tuned for long sessions — no pure black, no pure white.</p>
    </Card>
  );
}
