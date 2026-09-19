import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/preact';
import { afterEach, beforeEach } from 'vitest';

// Tear down the rendered tree after each test so queries never see a previous test's DOM.
afterEach(() => cleanup());

// Every test runs as a signed-in OWNER unless it says otherwise (7.13b). Role gating reads the
// identity from sessionStorage (lib/access.ts), and with nothing there the dashboard correctly
// assumes 'viewer' — which would hide the very buttons most tests exist to click. Tests that
// probe the gating itself overwrite this with a viewer or admin identity.
beforeEach(() => {
  sessionStorage.setItem('nx_identity', JSON.stringify({ role: 'owner', userId: 'u-test', name: 'Test Owner' }));
});

afterEach(() => sessionStorage.clear());
