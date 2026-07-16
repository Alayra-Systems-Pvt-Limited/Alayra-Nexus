import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { setToken } from './api';
import { App } from './app';

describe('App', () => {
  // The app is behind a sign-in gate (Phase 7.9b); seed a session token so the smoke test exercises the
  // signed-in shell rather than the login screen.
  beforeEach(() => setToken('test-session-token'));

  it('mounts the shell and lands on Overview', () => {
    render(<App />);
    // Shell chrome
    expect(screen.getByText('Alayra Nexus')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    // Overview landing content (subtitle is unique to the page, not the nav)
    expect(screen.getByText('Real-time gateway telemetry')).toBeInTheDocument();
  });
});
