import { Construction } from 'lucide-preact';
import type { Section } from '../nav';
import { PageHeader, Card } from '../ui';
import s from './pages.module.css';

/**
 * Every not-yet-built section renders here — the shell and navigation are real, the content is
 * still to come. Enterprise is the only one left.
 *
 * This used to name the phase that would fill the section ("built in P7.8"). Two reasons it no
 * longer does. The label had gone stale and was lying: P7.8 shipped as Teams, and Enterprise was
 * never in it. And our internal phase numbers mean nothing to the person reading the screen — they
 * are a promise in a private language, which is worse than no promise at all.
 */
export function Placeholder({ section }: { section: Section }) {
  return (
    <>
      <PageHeader title={section.label} subtitle={`The ${section.label} workspace`} />
      <Card>
        <div class={s.scaffold}>
          <Construction size={18} />
          <span>Coming soon. The shell, theme, and navigation around this section are live now.</span>
        </div>
      </Card>
    </>
  );
}
