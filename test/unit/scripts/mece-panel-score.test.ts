import { describe, expect, it } from 'vitest';
import {
  PLAN_BYTES_MIN,
  scoreMeceDiagnoseSeat,
  scoreMecePanel,
} from '../../../scripts/rotation/mece-panel-score.mjs';

describe('scoreMeceDiagnoseSeat', () => {
  it('marks ok when planBytes>=200 and exitCode 0 even if verdict is null', () => {
    const r = scoreMeceDiagnoseSeat({ planBytes: 4000, exitCode: 0, verdict: null });
    expect(r.ok).toBe(true);
    expect(r.planBytes).toBe(4000);
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBeNull();
  });

  it('ignores verdict=ok when plan is empty', () => {
    const r = scoreMeceDiagnoseSeat({ planBytes: 0, exitCode: 0, verdict: 'ok' });
    expect(r.ok).toBe(false);
  });

  it('fails when exitCode is non-zero even with large plan', () => {
    const r = scoreMeceDiagnoseSeat({ planBytes: 5000, exitCode: 1, verdict: 'ok' });
    expect(r.ok).toBe(false);
  });

  it('fails when planBytes is below minimum', () => {
    const r = scoreMeceDiagnoseSeat({ planBytes: PLAN_BYTES_MIN - 1, exitCode: 0 });
    expect(r.ok).toBe(false);
  });

  it('passes at exact planBytes minimum', () => {
    expect(scoreMeceDiagnoseSeat({ planBytes: PLAN_BYTES_MIN, exitCode: 0 }).ok).toBe(true);
  });
});

describe('scoreMecePanel', () => {
  it('allGreen only when every seat is ok and list non-empty', () => {
    const seats = [
      scoreMeceDiagnoseSeat({ planBytes: 4000, exitCode: 0, verdict: null }),
      scoreMeceDiagnoseSeat({ planBytes: 3000, exitCode: 0, verdict: null }),
      scoreMeceDiagnoseSeat({ planBytes: 2500, exitCode: 0, verdict: 'fail' }),
      scoreMeceDiagnoseSeat({ planBytes: 2000, exitCode: 0, verdict: null }),
    ];
    expect(scoreMecePanel(seats).allGreen).toBe(true);
  });

  it('allGreen false if any seat fails', () => {
    const seats = [
      scoreMeceDiagnoseSeat({ planBytes: 4000, exitCode: 0 }),
      scoreMeceDiagnoseSeat({ planBytes: 0, exitCode: 0 }),
    ];
    expect(scoreMecePanel(seats).allGreen).toBe(false);
  });

  it('allGreen false for empty seats', () => {
    expect(scoreMecePanel([]).allGreen).toBe(false);
  });
});
