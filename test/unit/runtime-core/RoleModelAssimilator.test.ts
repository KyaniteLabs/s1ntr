import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ASSIMILATION_ROLES,
  assimilateModelsByRole,
  parseModelAssimilationGateReceipt,
  parseRoleModelAssimilationReport,
  type ModelAssimilationGateReceipt,
  type RoleModelAssimilationInput,
} from '../../../src/index.js';

const receiptPath = path.resolve(
  'docs/agents/waves/receipts/wave-5-W5-13-model-assimilation.json',
);

describe('RoleModelAssimilator', () => {
  let receipt: ModelAssimilationGateReceipt;
  let input: RoleModelAssimilationInput;

  beforeAll(async () => {
    receipt = parseModelAssimilationGateReceipt(
      JSON.parse(await readFile(receiptPath, 'utf8')),
    );
    input = {
      decisionRule: receipt.report.decisionRule,
      auditions: receipt.report.auditions,
    };
  });

  it('compares every role without changing routes', () => {
    const report = assimilateModelsByRole(structuredClone(input));
    expect(parseRoleModelAssimilationReport(report)).toEqual(report);
    expect(report.routeMutation).toBe('forbidden');
    const covered = new Set(report.recommendations
      .filter(item => item.status !== 'unknown-identity')
      .map(item => item.role));
    expect(ASSIMILATION_ROLES.every(role => covered.has(role))).toBe(true);
  });

  it('preserves unknown provider identity and withholds recommendation', () => {
    const unknown = receipt.report.recommendations.find(item =>
      item.status === 'unknown-identity');
    expect(unknown).toMatchObject({
      challenger: {
        provider: null,
        model: null,
        verified: false,
        source: 'unknown',
      },
      allowedAction: 'none',
    });
  });

  it('rejects unequal comparison configuration', () => {
    const invalid = structuredClone(input);
    invalid.auditions[0].challenger.configurationDigest = 'a'.repeat(64);
    expect(() => assimilateModelsByRole(invalid))
      .toThrow(/CONFIGURATION_MISMATCH/);
  });

  it('retains baseline when a challenger misses the objective', () => {
    const weak = structuredClone(input);
    for (const audition of weak.auditions) {
      if (audition.challenger.identity.model === 'challenger-generator') {
        audition.challenger.metrics.quality = audition.baseline.metrics.quality;
      }
    }
    const report = assimilateModelsByRole(weak);
    const generator = report.recommendations.find(item =>
      item.challenger.model === 'challenger-generator');
    expect(generator?.status).toBe('retain-baseline');
    expect(generator?.allowedAction).toBe('none');
  });

  it('rejects report and gate tampering', () => {
    const report = structuredClone(receipt.report);
    report.routeMutation = 'allowed' as 'forbidden';
    expect(() => parseRoleModelAssimilationReport(report)).toThrow();

    const gate = structuredClone(receipt);
    gate.report.recommendations[0].meanEffect = 9;
    expect(() => parseModelAssimilationGateReceipt(gate)).toThrow(/digest mismatch/);
  });
});
