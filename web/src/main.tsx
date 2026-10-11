import { render } from 'preact';
// Self-hosted variable fonts (bundled via @fontsource — no CDN, works air-gapped).
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './app';
import { setToken, setIdentity } from './api';

// The static demo has no sign-in — there is no gateway to authenticate against, and a login screen
// in front of a demo is a door with nothing behind it. Seeding a token opens the app's auth gate;
// the identity is a VIEWER, so the role gating the dashboard already enforces hides every write
// control and a visitor sees the console exactly as a read-only member of the team would.
// Compile-time constant, so none of this exists in a production build.
if (import.meta.env.VITE_DEMO === '1') {
  setToken('demo');
  setIdentity({ role: 'viewer', userId: 'demo-viewer', name: 'Demo visitor' });
}

const root = document.getElementById('app');
if (root) render(<App />, root);
