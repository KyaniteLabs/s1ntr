import { describe, expect, it } from 'vitest';
import { LaneBreakers } from '../../../../src/atelier/judging/index.js';
import type { LaneDescriptor } from '../../../../src/atelier/judging/index.js';

const testLane = (model = 'model'): LaneDescriptor => ({
  sense: 'R1_PERCEPTUAL', provider: 'provider', model, transport: 'transport',
});

describe('LaneBreakers', () => {
  it('starts closed and permits a lane', () => {
    const breakers = new LaneBreakers();
    expect(breakers.state(testLane())).toBe('closed');
    expect(breakers.canUse(testLane())).toBe(true);
  });

  it('trips after the configured consecutive failure threshold', () => {
    const lane = testLane();
    const breakers = new LaneBreakers({ failureThreshold: 3 });
    breakers.recordFailure(lane);
    breakers.recordFailure(lane);
    expect(breakers.state(lane)).toBe('closed');
    breakers.recordFailure(lane);
    expect(breakers.state(lane)).toBe('open');
    expect(breakers.canUse(lane)).toBe(false);
  });

  it('uses an injected clock for the cooldown', () => {
    let now = 100;
    const lane = testLane();
    const breakers = new LaneBreakers({ failureThreshold: 1, cooldownMs: 50, now: () => now });
    breakers.recordFailure(lane);
    expect(breakers.canUse(lane)).toBe(false);
    now = 150;
    expect(breakers.canUse(lane)).toBe(true);
    expect(breakers.state(lane)).toBe('half-open');
  });

  it('allows only one half-open probe', () => {
    let now = 100;
    const lane = testLane();
    const breakers = new LaneBreakers({ failureThreshold: 1, cooldownMs: 1, now: () => now });
    breakers.recordFailure(lane);
    now = 101;
    expect(breakers.canUse(lane)).toBe(true);
    expect(breakers.canUse(lane)).toBe(false);
  });

  it('closes after a successful half-open probe', () => {
    let now = 0;
    const lane = testLane();
    const breakers = new LaneBreakers({ failureThreshold: 1, cooldownMs: 10, now: () => now });
    breakers.recordFailure(lane);
    now = 10;
    expect(breakers.canUse(lane)).toBe(true);
    breakers.recordSuccess(lane);
    expect(breakers.state(lane)).toBe('closed');
    expect(breakers.consecutiveFailures(lane)).toBe(0);
  });

  it('reopens when the half-open probe fails', () => {
    let now = 0;
    const lane = testLane();
    const breakers = new LaneBreakers({ failureThreshold: 1, cooldownMs: 10, now: () => now });
    breakers.recordFailure(lane);
    now = 10;
    expect(breakers.canUse(lane)).toBe(true);
    breakers.recordFailure(lane);
    expect(breakers.state(lane)).toBe('open');
  });

  it('keys breakers by provider, model, and transport', () => {
    const breakers = new LaneBreakers({ failureThreshold: 1 });
    const otherTransport = { ...testLane(), transport: 'other' };
    breakers.recordFailure(testLane());
    expect(breakers.canUse(testLane())).toBe(false);
    expect(breakers.canUse(otherTransport)).toBe(true);
  });

  it('can reset a benched lane', () => {
    const lane = testLane();
    const breakers = new LaneBreakers({ failureThreshold: 1 });
    breakers.recordFailure(lane);
    breakers.reset(lane);
    expect(breakers.state(lane)).toBe('closed');
    expect(breakers.canUse(lane)).toBe(true);
  });
});
