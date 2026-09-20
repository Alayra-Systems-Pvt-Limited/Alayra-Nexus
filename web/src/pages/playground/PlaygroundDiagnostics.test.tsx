import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import type { PlaygroundTrace } from '../../lib/playground';
import { PlaygroundDiagnostics } from './PlaygroundDiagnostics';

const trace: PlaygroundTrace = {
  requestedModel: 'alayra-nexus-1', resolution: 'auto', stream: true,
  scope: { namespace: 'shared', byok: false, isolated: false },
  route: {
    provider: 'anthropic', modelString: 'claude-sonnet-4-5', modelId: 'claude', tier: 'premium',
    keyId: 'key-1', keyMask: '••••9f3a', sticky: true, byok: false, downgraded: false, probe: false,
  },
  cache: 'bypassed',
  usage: { inputTokens: 1250, outputTokens: 320, estimatedUsd: 0.0042, savedUsd: 0, priced: true },
  timing: { ttfbMs: 245, upstreamMs: 1320, totalMs: 1375 },
  attempts: [{
    provider: 'anthropic', modelString: 'claude-sonnet-4-5', tier: 'premium', keyMask: '••••9f3a',
    status: 200, ttfbMs: 245, outcome: 'success',
  }],
  outcome: 'success',
};

describe('Playground routing diagnostics', () => {
  it('shows the exact route, timing, usage, cost, and masked provider attempt', () => {
    render(<PlaygroundDiagnostics trace={trace} />);

    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument();
    expect(screen.getByText('Requested: alayra-nexus-1')).toBeInTheDocument();
    expect(screen.getByText('anthropic · premium')).toBeInTheDocument();
    expect(screen.getByText('1,570')).toBeInTheDocument();
    expect(screen.getByText('$0.0042')).toBeInTheDocument();
    expect(screen.getByText('••••9f3a · premium')).toBeInTheDocument();
    expect(screen.queryByText(/sk-ant-api/i)).not.toBeInTheDocument();
  });

  it('distinguishes unknown pricing and exposes a refusal reason', () => {
    render(<PlaygroundDiagnostics trace={{
      ...trace,
      usage: { ...trace.usage!, estimatedUsd: 0, priced: false },
      outcome: 'upstream_error',
      refusal: { status: 429, reason: 'The provider answered 429.' },
      attempts: [{ ...trace.attempts[0], status: 429, outcome: 'rate_limited' }],
    }} />);

    expect(screen.getByText('Price unavailable')).toBeInTheDocument();
    expect(screen.getByText('Model pricing is not configured')).toBeInTheDocument();
    expect(screen.getByText(/The provider answered 429/)).toBeInTheDocument();
    expect(screen.getByText('Rate Limited')).toBeInTheDocument();
  });
});
