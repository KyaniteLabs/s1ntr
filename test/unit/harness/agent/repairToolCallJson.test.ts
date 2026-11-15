import { describe, expect, it } from 'vitest';
import {
  extractFirstJsonObject,
  extractToolAndParams,
  quoteBareStringFields,
  repairToolCallFromText,
} from '../../../../src/harness/agent/repairToolCallJson.js';

describe('repairToolCallJson', () => {
  it('quotes bare expectedResult (GLM Wave5 failure shape)', () => {
    const raw = `{
  "thought": "HARD RULE 3 requires loading both skills before inspection. comorbidity-check loaded; now systematic-debugging.",
  "tool": "executeSkill",
  "params": {"name": "systematic-debugging"},
  "expectedResult":Loads SKILL.md for systematic-debugging; I'll then build an evidence ledger with read-only harness tools before forming any hypothesis or plan.
}`;
    const fixed = quoteBareStringFields(raw);
    expect(() => JSON.parse(fixed)).not.toThrow();
    const parsed = JSON.parse(fixed);
    expect(parsed.tool).toBe('executeSkill');
    expect(parsed.params.name).toBe('systematic-debugging');
    expect(String(parsed.expectedResult)).toContain('Loads SKILL.md');
  });

  it('repairToolCallFromText recovers tool+params from GLM raw', () => {
    const raw = `{
  "thought": "load second skill",
  "tool": "executeSkill",
  "params": {"name": "systematic-debugging"},
  "expectedResult":Loads SKILL.md for systematic-debugging; I'll then build an evidence ledger.
}`;
    const repaired = repairToolCallFromText(raw);
    expect(repaired!.tool).toBe('executeSkill');
    expect(repaired!.params).toEqual({ name: 'systematic-debugging' });
  });

  it('extractToolAndParams recovers name-only skill calls', () => {
    const text = `"tool": "executeSkill", "params": {"name": "comorbidity-check"}`;
    const extracted = extractToolAndParams(text);
    expect(extracted?.tool).toBe('executeSkill');
    expect(extracted?.params).toEqual({ name: 'comorbidity-check' });
  });

  it('extractFirstJsonObject finds balanced object', () => {
    const text = 'noise { "a": { "b": 1 }, "c": 2 } trailing';
    const obj = extractFirstJsonObject(text);
    expect(obj).toBe('{ "a": { "b": 1 }, "c": 2 }');
  });
});
