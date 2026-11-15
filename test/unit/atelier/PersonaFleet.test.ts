import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPersonaPromptBias, getMachinePersona, listPersonas, checkCalibrationGate } from '../../../src/atelier/PersonaFleet.js';

describe('PersonaFleet (Build 1 — cognitive-style personas)', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sinter-persona-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('builds a deterministic prompt bias from persona state', () => {
    const personas = listPersonas(cwd);
    const diverger = personas.find(p => p.id === 'diverger')!;
    const bias1 = buildPersonaPromptBias(diverger);
    const bias2 = buildPersonaPromptBias(diverger);
    expect(bias1).toBe(bias2); // deterministic
    expect(bias1).toContain('novel'); // diverger has exploration: 0.9
    expect(bias1).toContain('cross-pollinate'); // connectiveBias: 0.9
  });

  it('assigns a persona to this machine and persists it atomically', () => {
    const persona = getMachinePersona(cwd);
    expect(['perceiver', 'deep-diver', 'diverger', 'synthesist', 'adversary']).toContain(persona?.id);
    expect(persona!.styleVector).toHaveProperty('exploration');
    expect(persona!.systemPromptBias.length).toBeGreaterThan(20);
    // Second call returns the same persona (atomic, no drift)
    const again = getMachinePersona(cwd);
    expect(again!.id).toBe(persona!.id);
  });

  it('ships no machine host names in the default personas', () => {
    const hints = listPersonas(cwd).map(p => p.machineHint);
    expect(hints).toEqual(['', '', '', '', '']);
  });

  it('pins the persona named by SINTER_PERSONA and ignores an unknown one', () => {
    const before = process.env.SINTER_PERSONA;
    try {
      process.env.SINTER_PERSONA = 'diverger';
      expect(getMachinePersona(cwd)!.id).toBe('diverger');

      const other = mkdtempSync(join(tmpdir(), 'sinter-persona-'));
      process.env.SINTER_PERSONA = 'no-such-persona';
      const ids = listPersonas(cwd).map(p => p.id);
      expect(ids).toContain(getMachinePersona(other)!.id);
      rmSync(other, { recursive: true, force: true });
    } finally {
      if (before === undefined) delete process.env.SINTER_PERSONA; else process.env.SINTER_PERSONA = before;
    }
  });

  it('lists all 5 personas with derived prompts', () => {
    const personas = listPersonas(cwd);
    expect(personas).toHaveLength(5);
    expect(personas.every(p => p.systemPromptBias.length > 0)).toBe(true);
    const ids = personas.map(p => p.id);
    expect(ids).toContain('perceiver');
    expect(ids).toContain('adversary');
  });

  it('calibration gate fails with insufficient observations', () => {
    const gate = checkCalibrationGate(cwd);
    expect(gate.passed).toBe(false);
    expect(gate.observations).toBe(0);
  });
});
