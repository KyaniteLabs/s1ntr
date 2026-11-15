import { describe, expect, it } from 'vitest';
import {
  buildOracleReceipt,
  oracleControlCandidate,
  oracleTreatmentCandidate,
  scoreOracleDualEval,
} from '../../../src/runtime-core/DreamTransferOracle.js';

describe('DreamTransferOracle', () => {
  it('builds distinct flat control and layered treatment fixtures', () => {
    const control = oracleControlCandidate();
    const treatment = oracleTreatmentCandidate();
    expect(control.source).not.toBe(treatment.source);
    expect(control.graphDigest).not.toBe(treatment.graphDigest);
    expect(control.source).toContain('fillStyle');
    expect(control.source).not.toContain('ellipse');
    expect(treatment.source).toContain('ellipse');
    expect(treatment.source).toContain('depth stacking');
  });

  it('passes oracle gate only on dual-validated', () => {
    expect(scoreOracleDualEval('validated', 'validated').gate).toBe('pass');
    expect(scoreOracleDualEval('falsified', 'falsified').gate).toBe('abort');
    expect(scoreOracleDualEval('validated', 'falsified').gate).toBe('abort');
    expect(scoreOracleDualEval('falsified', 'validated').gate).toBe('abort');
    expect(scoreOracleDualEval('inconclusive', 'inconclusive').gate).toBe('abort');
  });

  it('builds receipt with holdoutsAllowed only when gate passes', () => {
    const pass = buildOracleReceipt('validated', 'validated');
    expect(pass.schema).toBe('sinter.wave8-transfer-oracle-receipt');
    expect(pass.holdoutsAllowed).toBe(true);
    expect(pass.gate).toBe('pass');
    const abort = buildOracleReceipt('validated', 'falsified');
    expect(abort.holdoutsAllowed).toBe(false);
    expect(abort.gate).toBe('abort');
  });
});
