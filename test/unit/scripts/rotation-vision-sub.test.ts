import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BATTERIES = path.resolve('scripts/rotation/batteries.mjs');
const CLI = path.resolve('scripts/rotation/cli.mjs');

describe('tour vision-sub and grok seat markers', () => {
  it('does not pass an unset vision-sub key into createLlmClient', () => {
    const source = readFileSync(BATTERIES, 'utf8');
    expect(source).toMatch(/vision-sub key missing/);
    expect(source).toMatch(/vision-sub construct failed/);
    expect(source).not.toMatch(/SINTER_TOUR_VISION_SUB_API_KEY \|\| undefined/);
  });

  it('marks grok-oidc roles as a subscription seat instead of hostname trust', () => {
    const source = readFileSync(CLI, 'utf8');
    expect(source).toMatch(/grokSubscriptionSeat: grok\.keySource === 'grok-oidc'/);
  });
});
