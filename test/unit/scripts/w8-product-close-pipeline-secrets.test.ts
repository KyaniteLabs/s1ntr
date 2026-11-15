import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PIPELINE = path.resolve('scripts/w8-product-close-pipeline.mts');
const BIND = path.resolve('scripts/w8-bind-product-close.mts');
const DREAM = path.resolve('scripts/w8-owner-decisions-dream.mts');

describe('wave8 close scripts do not embed secrets', () => {
  it('does not interpolate MiniMax or Codex keys into the pipeline summary', () => {
    const source = readFileSync(PIPELINE, 'utf8');
    expect(source).not.toMatch(
      /SINTER_CAMPAIGN_SEAT_KEY_SPECIALIST_REVIEW:\s*process\.env\.MINIMAX_API_KEY\s*\?\?/,
    );
    expect(source).not.toMatch(
      /SINTER_CAMPAIGN_SEAT_KEY_HOLISTIC_REVIEW:\s*process\.env\.CODEX_PROXY_API_KEY\s*\?\?/,
    );
    expect(source).toMatch(
      /SINTER_CAMPAIGN_SEAT_KEY_SPECIALIST_REVIEW:\s*process\.env\.MINIMAX_API_KEY \? 'set' : ''/,
    );
  });

  it('dream and bind require KIMI_API_KEY instead of a hardcoded key', () => {
    const dream = readFileSync(DREAM, 'utf8');
    const bind = readFileSync(BIND, 'utf8');
    expect(dream).toMatch(/process\.env\.KIMI_API_KEY/);
    expect(dream).not.toMatch(/sk-kimi-/);
    expect(bind).toMatch(/KIMI_API_KEY/);
    expect(bind).not.toMatch(/sk-kimi-/);
  });

  it('bind and dream refuse stale compose rebinding and do not mint owner packets', () => {
    const dream = readFileSync(DREAM, 'utf8');
    const bind = readFileSync(BIND, 'utf8');
    expect(bind).toMatch(/assertComposeBoundToCurrentSource/);
    expect(dream).toMatch(/loadVerifiedOwnerDecisionPackets/);
    expect(dream).toMatch(/owner\.public\.pem/);
    expect(dream).not.toMatch(/owner\.private\.pem/);
    expect(dream).not.toMatch(/sign\(null,/);
  });
});
