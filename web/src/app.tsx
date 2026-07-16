import type { FunctionComponent } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { LocationProvider, Router, Route } from 'preact-iso';
import { AppShell } from './shell/AppShell';
import { SECTIONS } from './nav';
import { getToken } from './api';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Nexus } from './pages/Nexus';
import { Connect } from './pages/Connect';
import { Analytics } from './pages/Analytics';
import { Teams } from './pages/Teams';
import { Security } from './pages/Security';
import { Caching } from './pages/Caching';
import { Settings } from './pages/Settings';
import { Logs } from './pages/Logs';
import { Placeholder } from './pages/Placeholder';
import { PageHeader, Card } from './ui';

// Sections with a redesigned page of their own; the rest fall through to Placeholder until their
// phase lands. Models folded into Nexus in P7.4b — a pool now owns its own models.
const PAGES: Record<string, FunctionComponent> = {
  nexus:     Nexus,
  connect:   Connect,
  analytics: Analytics,
  teams:     Teams,
  security:  Security,
  caching:   Caching,
  settings:  Settings,
  logs:      Logs,
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
 * every other section renders its Placeholder until its phase lands. Deep links work because
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

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  return (
    <LocationProvider>
      <AppShell>
        <Router>
          <Route path="/" component={Overview} />
          {SECTIONS.filter((sec) => sec.id !== 'overview').map((sec) => {
            const Page = PAGES[sec.id];
            return <Route key={sec.id} path={sec.path} component={Page ?? (() => <Placeholder section={sec} />)} />;
          })}
          <Route default component={NotFound} />
        </Router>
      </AppShell>
    </LocationProvider>
  );
}
