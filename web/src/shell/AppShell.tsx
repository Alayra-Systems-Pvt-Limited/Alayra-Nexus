import type { ComponentChildren } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import s from './shell.module.css';

/**
 * The persistent frame: sidebar + top bar, with the routed page in the scrolling content area.
 *
 * On a narrow screen (P7.17d) the sidebar is a drawer instead of a fixed column — 232px of
 * permanent navigation is most of a phone. The hamburger lives in the top bar and only appears
 * under the breakpoint; everything here is inert on a desktop, where the drawer classes never apply.
 */
export function AppShell({ children }: { children?: ComponentChildren }) {
  const [navOpen, setNavOpen] = useState(false);
  const { path } = useLocation();

  // Following a link should close the drawer — otherwise it stays open over the page you just
  // asked for. Escape closes it too, matching every other dismissable surface in the app.
  useEffect(() => { setNavOpen(false); }, [path]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div class={s.shell}>
      <Sidebar open={navOpen} />
      {navOpen && <div class={s.navScrim} onClick={() => setNavOpen(false)} />}
      <div class={s.main}>
        <Topbar onMenu={() => setNavOpen((v) => !v)} navOpen={navOpen} />
        <main class={s.content}>
          <div class={s.contentInner}>{children}</div>
        </main>
      </div>
    </div>
  );
}
