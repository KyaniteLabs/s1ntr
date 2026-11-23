import { describe, expect, it } from 'vitest';
import { EngineSettingsError, parseEngineReply } from '../../../src/generators/engine/EngineSettings.js';
import { nbeEmitterPoints, validateNbeSettings } from '../../../src/generators/nbe/NbeSettings.js';

const GOOD = { palette: ['#000', '#123456', '#abcdef'], layout: 'scatter', reason: 'Scattered cold sparks fit the brief.' };

describe('engine settings contract (nbe)', () => {
  it('accepts a minimal reply, fills defaults and records which', () => {
    const c = validateNbeSettings(GOOD);
    expect(c.settings.layout).toBe('scatter');
    expect(c.settings.flow).toBe(1);
    expect(c.defaulted).toContain('flow');
    expect(c.reason).toBe(GOOD.reason);
  });

  it('clamps numbers and rounds integers, recording each clamp', () => {
    const c = validateNbeSettings({ ...GOOD, emitters: 40.4, glow: -1 });
    expect(c.settings.emitters).toBe(8);
    expect(c.settings.glow).toBe(0);
    expect(c.clamped).toEqual(['emitters: 40.4 -> 8', 'glow: -1 -> 0']);
  });

  it('rejects wrong types with every problem named at once', () => {
    let error: unknown;
    try { validateNbeSettings({ palette: 'blue', layout: 'zigzag', flow: 'fast', reason: 'x' }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(EngineSettingsError);
    const problems = (error as EngineSettingsError).problems;
    expect(problems).toHaveLength(4);
    expect((error as Error).message).toContain('nbe settings invalid');
  });

  it('rejects a non-object reply and unparseable text', () => {
    expect(() => validateNbeSettings([1, 2])).toThrow(EngineSettingsError);
    expect(() => parseEngineReply('nbe', 'no json here')).toThrow(/not valid JSON/);
  });

  it('parses a reply wrapped in fences', () => {
    const raw = parseEngineReply('nbe', '```json\n' + JSON.stringify(GOOD) + '\n```');
    expect(validateNbeSettings(raw).settings.palette).toEqual(['#000', '#123456', '#abcdef']);
  });

  it('places emitters deterministically by layout', () => {
    const a = nbeEmitterPoints({ layout: 'ring', emitters: 4, seed: 3 });
    expect(a).toEqual(nbeEmitterPoints({ layout: 'ring', emitters: 4, seed: 3 }));
    expect(a).toHaveLength(4);
    expect(nbeEmitterPoints({ layout: 'corners', emitters: 1, seed: 3 })).toHaveLength(4);
    expect(nbeEmitterPoints({ layout: 'center', emitters: 6, seed: 3 })).toEqual([[0.5, 0.5]]);
  });
});
