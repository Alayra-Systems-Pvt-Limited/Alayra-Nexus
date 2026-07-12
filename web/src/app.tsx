import type { FunctionComponent } from 'preact';
import { LocationProvider, Router, Route } from 'preact-iso';
import { AppShell } from './shell/AppShell';
import { SECTIONS } from './nav';
import { Overview } from './pages/Overview';
import { Nexus } from './pages/Nexus';
import { Connect } from './pages/Connect';
import { Placeholder } from './pages/Placeholder';
import { PageHeader, Card } from './ui';

// Sections with a redesigned page of their own; the rest fall through to Placeholder until their
// phase lands. Models folded into Nexus in P7.4b — a pool now owns its own models.
const PAGES: Record<string, FunctionComponent> = {
  nexus:   Nexus,
  connect: Connect,
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
