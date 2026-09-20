import type { FunctionComponent } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { LocationProvider, Router, Route } from 'preact-iso';
import { AppShell } from './shell/AppShell';
import { SECTIONS } from './nav';
import { getToken } from './api';
import { BASE, href } from './base';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Nexus } from './pages/Nexus';
import { Connect } from './pages/Connect';
import { Playground } from './pages/Playground';
import { Analytics } from './pages/Analytics';
import { Teams } from './pages/Teams';
import { Security } from './pages/Security';
import { Caching } from './pages/Caching';
import { Health } from './pages/Health';
import { Admin } from './pages/Admin';
import { AcceptInvite } from './pages/login/AcceptInvite';
import { Settings } from './pages/Settings';
import { Logs } from './pages/Logs';
import { PageHeader, Card } from './ui';

// Every public navigation section has a real page. Keep unfinished work out of SECTIONS until it is
// usable; a visible "coming soon" route makes the release look less complete than it is.
const PAGES: Record<string, FunctionComponent> = {
  nexus:     Nexus,
  connect:   Connect,
  playground: Playground,
  analytics: Analytics,
  teams:     Teams,
  security:  Security,
  caching:   Caching,
  health:    Health,
  settings:  Settings,
  logs:      Logs,
  admin:     Admin,
};

function NotFound() {
  return (
    <>
      <PageHeader title="Not found" subtitle="No such section" />
      <Card>That page doesn’t exist. Use the sidebar to navigate.</Card>
    </>
  );
}

/**
 * The app: a persistent shell wrapping a client-side router. Overview is the landing plane;
 * every other section renders its own page. Deep links work because
 * preact-iso intercepts same-origin anchor navigations under LocationProvider.
 */
export function App() {
  // Auth gate: render the sign-in screen until there is a session token. `authed` seeds synchronously
  // from the stored token so an already-signed-in reload never flashes the login screen. A 401 from any
  // API call clears the token and fires `nx:unauthorized` (see api.ts), which drops back to sign-in.
  const [authed, setAuthed] = useState(() => !!getToken());
  useEffect(() => {
    const onUnauth = () => setAuthed(false);
    window.addEventListener('nx:unauthorized', onUnauth);
    return () => window.removeEventListener('nx:unauthorized', onUnauth);
  }, []);

  // Accepting an invite happens BEFORE there is an account to sign in with, so it has to sit outside
  // the auth gate (Phase 7.13a). Read from the URL directly rather than through the router, which
  // only mounts below this line — and matched on the path so a signed-in operator who clicks their
  // own invite link is not silently dropped into the dashboard instead.
  if (typeof window !== 'undefined' && window.location.pathname === '/invite') {
    return <AcceptInvite onAuthed={() => setAuthed(true)} />;
  }

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  return (
    // `scope` keeps the router's click interception inside the mount point, and `href()` puts the
    // mount prefix on each route pattern — preact-iso matches against the raw pathname and does not
    // strip a base itself. Both are no-ops at the site root, which is every real deployment.
    <LocationProvider scope={BASE || undefined}>
      <AppShell>
        <Router>
          <Route path={BASE || '/'} component={Overview} />
          {SECTIONS.filter((sec) => sec.id !== 'overview').map((sec) => {
            const Page = PAGES[sec.id];
            return <Route key={sec.id} path={href(sec.path)} component={Page ?? NotFound} />;
          })}
          <Route default component={NotFound} />
        </Router>
      </AppShell>
    </LocationProvider>
  );
}
