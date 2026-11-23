import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseMetaDescriptorFromHtml } from '../../../src/generators/custom/CustomGenerator.js';
import { decideGenerateMedium, describeMedium, parseMetaDescriptor } from '../../../src/core/MediumLine.js';
import { runProductionCliGenerate } from '../../../src/cli/LiminalProductionGenerate.js';

const CUSTOM = `<!--SINTER-META-DESCRIPTOR {"name":"reaction-diffusion","runtime":"canvas","libraries":[],"renderTarget":"#stage","notes":"Gray-Scott simulation drawn per frame"} -->
<!DOCTYPE html><html><head><title>t</title></head><body><canvas id="stage"></canvas></body></html>`;

describe('describeMedium', () => {
  it('parses descriptors exactly like CustomGenerator does', () => {
    expect(parseMetaDescriptor(CUSTOM)).toEqual(parseMetaDescriptorFromHtml(CUSTOM));
    expect(parseMetaDescriptor('<html></html>')).toBeNull();
  });

  it('names a custom medium by its descriptor, never as bare custom', () => {
    const record = describeMedium({ domain: 'custom', source: CUSTOM,
      decision: { source: 'prompt-cue', reason: 'the prompt asked for a simulation' } });
    expect(record.medium_line).toBe('S1NTR built a custom medium "reaction-diffusion" (canvas), rendering to #stage. '
      + 'Why: the prompt asked for a simulation. Technique: Gray-Scott simulation drawn per frame.');
    expect(record.descriptor?.name).toBe('reaction-diffusion');
  });

  it('lists the libraries the artifact actually uses', () => {
    const record = describeMedium({ domain: 'p5',
      source: '<script src="/vendor/p5/1.9.0/p5.min.js"></script><script>function setup(){createCanvas(10,10)}</script>',
      decision: { source: 'forced', reason: 'the operator asked for p5 with --domain' } });
    expect(record.libraries).toEqual(['p5.js']);
    expect(record.medium_line).toContain('p5.js sketch, using p5.js, rendering to canvas');
  });

  it('describes a hybrid by its layers and roles', () => {
    const record = describeMedium({ domain: 'glsl', source: '', libraries: ['WebGL/GLSL', 'Tone.js'],
      renderTarget: 'canvas',
      decision: { source: 'planner', reason: 'a dark field needs depth, motion and a pulse' },
      layers: [{ id: 'l0', domain: 'glsl', role: 'background' }, { id: 'l1', domain: 'kinetic', role: 'overlay' },
        { id: 'l2', domain: 'tone', role: 'sound' }] });
    expect(record.kind).toBe('layered');
    expect(record.medium_line).toContain('layered piece of glsl background + kinetic overlay + tone sound');
  });

  it('says out loud when a default stood in for a choice', () => {
    const decision = decideGenerateMedium({ domain: 'p5', forced: false, detected: undefined });
    expect(decision.source).toBe('default');
    expect(decision.reason).toContain('fell back to p5');
  });
});

describe('governed generate writes medium.json', () => {
  it('records the medium line next to the artifact and returns it', async () => {
    const outputRoot = mkdtempSync(path.join(tmpdir(), 'medium-run-'));
    const operationId = 'operation:medium';
    const dir = path.join(outputRoot, 'artifacts', createHash('sha256').update(operationId).digest('hex'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'source.txt'), CUSTOM);
    const factory = vi.fn(async () => ({ createCommand: () => ({ idempotencyKey: 'k' }),
      port: { submitCreate: async () => ({ kind: 'create', result: { operationId } }) },
      close: async () => undefined }) as never);
    const generated = await runProductionCliGenerate({ prompt: 'a living simulation', domain: 'custom',
      outputRoot, mediumDecision: { source: 'prompt-cue', reason: 'the prompt asked for a simulation' } }, factory);
    const written = JSON.parse(readFileSync(path.join(dir, 'medium.json'), 'utf8'));
    expect(written.medium_line).toBe(generated.mediumLine);
    expect(written.medium_line).toContain('"reaction-diffusion"');
  });

  it('reads old medium.json (medium_line, kind hybrid) and new (made_with, kind layered)', async () => {
    const { readMediumRecord } = await import('../../../src/core/MediumLine.js');
    expect(readMediumRecord({ medium_line: 'old', kind: 'hybrid' })).toEqual({ made_with: 'old', kind: 'layered' });
    expect(readMediumRecord({ made_with: 'new', kind: 'layered' })).toEqual({ made_with: 'new', kind: 'layered' });
    expect(() => readMediumRecord({})).toThrow(/neither made_with nor medium_line/);
  });
});
