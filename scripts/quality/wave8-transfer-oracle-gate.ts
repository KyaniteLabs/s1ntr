/**
 * Wave 8 transfer oracle hard-gate (AC6).
 * Scores dual-eval labels against fixed flat/layered fixtures.
 *
 * Offline usage (no providers): pass eval labels as args.
 *   pnpm exec tsx scripts/quality/wave8-transfer-oracle-gate.ts validated validated
 *   pnpm exec tsx scripts/quality/wave8-transfer-oracle-gate.ts validated falsified
 *
 * Exit 0 when gate=pass (dual-validated); exit 1 when abort (split or dual-falsified).
 */
import {
  buildOracleReceipt,
  oracleControlCandidate,
  oracleTreatmentCandidate,
} from '../../src/runtime-core/DreamTransferOracle.js';
import type { DreamTransferOutcome } from '../../src/dreaming/research/DreamResearchTypes.js';

const allowed = new Set(['validated', 'falsified', 'inconclusive']);

function parseOutcome(raw: string | undefined): DreamTransferOutcome {
  if (!raw || !allowed.has(raw)) {
    throw new Error(`Usage: wave8-transfer-oracle-gate.ts <eval1> <eval2>
  each of: validated | falsified | inconclusive`);
  }
  return raw as DreamTransferOutcome;
}

const eval1 = parseOutcome(process.argv[2]);
const eval2 = parseOutcome(process.argv[3]);
const receipt = buildOracleReceipt(eval1, eval2);
const control = oracleControlCandidate();
const treatment = oracleTreatmentCandidate();

console.log(JSON.stringify({
  ...receipt,
  controlId: control.id,
  treatmentId: treatment.id,
}, null, 2));

process.exitCode = receipt.gate === 'pass' ? 0 : 1;
