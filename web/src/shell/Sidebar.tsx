import { useLocation } from 'preact-iso';
import { clsx } from 'clsx';
import { SECTIONS, sectionByPath, type Section } from '../nav';
import { useBranding } from '../hooks/useBranding';
import s from './shell.module.css';

function NavLink({ section, activeId }: { section: Section; activeId?: string }) {
  const Icon = section.icon;
  return (
    <a
      href={section.path}
      class={clsx(s.navItem, activeId === section.id && s.navActive)}
      aria-current={activeId === section.id ? 'page' : undefined}
    >
      <Icon size={17} />
      <span>{section.label}</span>
    </a>
  );
}

export function Sidebar({ open = false }: { open?: boolean }) {
  const { path } = useLocation();
  const activeId = sectionByPath(path)?.id;
  const workspace = SECTIONS.filter((x) => x.group === 'workspace');
  const system = SECTIONS.filter((x) => x.group === 'system');

  // Operator branding (P7.11) takes the headline; the product name moves to the line beneath rather
  // than disappearing, so a white-labelled console still says what it is. Unset → the product's own
  // mark and name, exactly as before.
  const brand = useBranding();
  const name  = brand.companyName || 'Alayra Nexus';

  return (
    <aside class={clsx(s.sidebar, open && s.sidebarOpen)}>
      <a href="/" class={s.brand} aria-label={`${name} — Overview`}>
        <img class={s.brandMark} src={brand.logoDataUri || '/logo.svg'} width="26" height="26" alt="" />
        <span>
          <div class={s.brandText}>{name}</div>
          <div class={s.brandBy}>{brand.companyName ? 'Alayra Nexus' : 'by Alayra Systems'}</div>
        </span>
      </a>

      <nav class={s.navGroup} aria-label="Primary">
        {workspace.map((sec) => <NavLink key={sec.id} section={sec} activeId={activeId} />)}
      </nav>

      <div class={s.navDivider} />

      <nav class={s.navGroup} aria-label="System">
        {system.map((sec) => <NavLink key={sec.id} section={sec} activeId={activeId} />)}
      </nav>

      <div class={s.navSpacer} />
      <div class={s.navFoot}>Alayra Nexus™ · v1.2.0</div>
    </aside>
  );
}
