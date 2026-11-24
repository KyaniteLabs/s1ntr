import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createLiminalProductionEffects, isLiminalProductionDomain,
} from '../../../src/runtime-core/LiminalProductionEffects.js';
import { CodeValidator } from '../../../src/core/CodeValidator.js';
import { isCodeComplete } from '../../../src/core/isCodeComplete.js';
import { detectPromptDomain } from '../../../src/core/detectPromptDomain.js';
import { NbeGenerator } from '../../../src/generators/nbe/NbeGenerator.js';

vi.mock('../../../src/generators/DomainTeaching.js', () => ({ buildDomainTeaching: () => '' }));

// nbe was registered as a generator but missing from the governed domain list,
// so `sinter generate --domain nbe` refused before any model call. It is now a
// first-class governed domain: the artifact is a self-contained NBE HTML
// document (canvas cascade neural field + convergence signal), rendered the
// same way kinetic/html render.

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>NBE — Neural Bloom Engine</title>
<style>
  html, body { margin: 0; height: 100%; background: #04060a; }
  #stage { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<script>
(function () {
  'use strict';
  var CASCADE = [
    { freq: 0.6, amp: 0.9, phaseX: 0.0, phaseY: 0.5, speed: 0.15 },
    { freq: 1.3, amp: 0.6, phaseX: 1.1, phaseY: 2.0, speed: 0.27 }
  ];
  var canvas = document.getElementById('stage');
  canvas.width = 192; canvas.height = 120;
  var ctx = canvas.getContext('2d');
  var img = ctx.createImageData(canvas.width, canvas.height);
  var dens = new Float32Array(canvas.width * canvas.height);
  var steps = 0, time = 0;
  function field(x, y, t) {
    var vx = 0, vy = 0;
    for (var l = 0; l < CASCADE.length; l++) {
      var L = CASCADE[l];
      vx += L.amp * Math.sin(L.freq * x + L.phaseX + t * L.speed);
      vy += L.amp * Math.cos(L.freq * y + L.phaseY + t * L.speed * 0.83);
    }
    return [vx, vy];
  }
  function step() {
    time += 0.016;
    for (var y = 0; y < canvas.height; y++) {
      for (var x = 0; x < canvas.width; x++) {
        var v = field(x / canvas.width, y / canvas.height, time);
        dens[y * canvas.width + x] *= 0.985 + 0.001 * v[0];
      }
    }
    ctx.putImageData(img, 0, 0);
    steps++;
    if (steps >= 600) {
      window.postMessage('nbe:converged', '*');
    }
  }
  function loop() { step(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
})();
</script>
</body>
</html>`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeRenderer() {
  return {
    preflightSandbox: (code: string) => ({
      sourceDigest: createHash('sha256').update(code).digest('hex'),
      networkPolicy: 'isolated' as const, realtimeTransportsDenied: true as const, outputLimitEnforced: true as const,
    }),
    render: vi.fn(async () => ({ rendered: true, success: true, logs: [], errors: [],
      screenshot: { buffer: PNG, width: 640, height: 360, success: true },
      lateScreenshot: { buffer: Buffer.concat([PNG, Buffer.from([1])]), width: 640, height: 360, success: true } })),
  };
}

describe('governed nbe generate', () => {
  it('is a governed production domain', () => {
    expect(isLiminalProductionDomain('nbe')).toBe(true);
  });

  it('validates the NBE document: canvas mount + convergence signal', () => {
    expect(CodeValidator.validate(PAGE, 'nbe').valid).toBe(true);
    expect(isCodeComplete(PAGE, 'nbe')).toBe(true);
    // The deterministic generator's own output satisfies the same contract.
    expect(CodeValidator.validate(new NbeGenerator().generate('aurora bloom').code, 'nbe').valid).toBe(true);
    const bare = PAGE.replace(/<canvas id="stage"><\/canvas>/, '<div id="stage"></div>');
    expect(CodeValidator.validate(bare, 'nbe').errors).toContain(
      'nbe code must include a <canvas> for the cascade neural-field simulation');
    const silent = PAGE.replace(/window\.postMessage\('nbe:converged', '\*'\);/, ';');
    expect(CodeValidator.validate(silent, 'nbe').errors).toContain(
      'nbe code must post the "nbe:converged" signal via window.postMessage once the field has evolved');
  });

  it('detects NBE prompts and routes them to the nbe domain', async () => {
    expect(await detectPromptDomain('create a neural bloom engine render')).toBe('nbe');
    expect(await detectPromptDomain('NBE flowing fluid art')).toBe('nbe');
  });

  const SETTINGS_A = { palette: ['#05030f', '#2a0f5c', '#b0306a', '#ffb347'], layout: 'ring', emitters: 5,
    fieldScale: 2.4, fieldLayers: 5, flow: 1.8, swirl: 0.8, speed: 1.4, persistence: 0.99, glow: 0.9, seed: 7,
    reason: 'A ring of embers wants warm colour and tight vortices.' };
  const SETTINGS_B = { palette: ['#000814', '#003566', '#00b4d8', '#e0fbfc'], layout: 'line', emitters: 3,
    fieldScale: 0.6, fieldLayers: 3, flow: 0.7, swirl: 0.1, speed: 0.5, persistence: 0.97, glow: 0.3, seed: 99,
    reason: 'A calm horizon needs slow wide currents in cold blues.' };

  function makeEffects(replies: string[]) {
    const generate = vi.fn().mockResolvedValue({ success: true, code: replies.at(-1) });
    for (const r of replies) generate.mockResolvedValueOnce({ success: true, code: r });
    const effects = createLiminalProductionEffects({
      generator: { getConfig: () => ({ provider: 'fake', model: 'generator' }), generate } as never,
      evaluator: {} as never, renderer: fakeRenderer() as never,
      generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
    });
    const run = (prompt: string) => effects.generate({ identity: 'fake/generator', domain: 'nbe', prompt,
      startTransport: vi.fn(async () => 1), failTransport: vi.fn(async () => {}) });
    return { generate, run };
  }

  it('renders the model-chosen settings with the engine and records what was chosen and why', async () => {
    const { generate, run } = makeEffects([JSON.stringify(SETTINGS_A)]);
    const artifact = await run('Embers circling a dying star');
    expect(artifact.playable.trim().startsWith('<!DOCTYPE html')).toBe(true);
    expect(artifact.playable).toContain('data-sinter-engine="nbe"');
    expect(artifact.playable).toContain('nbe:converged');
    expect(artifact.playable).toContain('[176,48,106]');
    const provenance = JSON.parse(artifact.provenance);
    expect(provenance.domain).toBe('nbe');
    expect(provenance.engine.reason).toBe(SETTINGS_A.reason);
    expect(provenance.engine.settings.layout).toBe('ring');
    expect(provenance.engine.settings.emitters).toBe(5);
    expect(JSON.stringify(generate.mock.calls[0])).toContain('Reply with ONE JSON object of nbe engine settings');
  });

  it('gives visibly different pages for different prompts', async () => {
    const a = await makeEffects([JSON.stringify(SETTINGS_A)]).run('Embers circling a dying star');
    const b = await makeEffects([JSON.stringify(SETTINGS_B)]).run('A calm horizon before dawn');
    expect(a.playable).not.toBe(b.playable);
    expect(JSON.parse(a.provenance).engine.settings.palette).not.toEqual(JSON.parse(b.provenance).engine.settings.palette);
  });

  it('clamps out-of-range numbers and records the clamp', async () => {
    const { run } = makeEffects([JSON.stringify({ ...SETTINGS_B, flow: 99, swirl: -4 })]);
    const provenance = JSON.parse((await run('storm')).provenance);
    expect(provenance.engine.settings.flow).toBe(3);
    expect(provenance.engine.settings.swirl).toBe(0);
    expect(provenance.engine.clamped).toEqual(['flow: 99 -> 3', 'swirl: -4 -> 0']);
  });

  it('runs one repair round when the settings are invalid, naming every problem', async () => {
    const { generate, run } = makeEffects([
      JSON.stringify({ ...SETTINGS_A, palette: ['red', 'blue'], layout: 'spiral', reason: '' }),
      JSON.stringify(SETTINGS_A),
    ]);
    const artifact = await run('Embers circling a dying star');
    expect(generate).toHaveBeenCalledTimes(2);
    const repairCall = JSON.stringify(generate.mock.calls[1]);
    expect(repairCall).toContain('NBE_SETTINGS: palette must be 3 to 6 hex colours');
    expect(repairCall).toContain('NBE_SETTINGS: layout must be one of');
    expect(repairCall).toContain('NBE_SETTINGS: reason must be one sentence');
    expect(JSON.parse(artifact.provenance).acceptedFrom).toBe('repair');
  });

  it('fails loudly, naming the domain, when the repair is also invalid', async () => {
    const { run } = makeEffects(['not json at all', 'still {nope']);
    await expect(run('anything')).rejects.toThrow(/LIMINAL_GENERATION_INVALID:nbe:.*NBE_SETTINGS/);
  });

  it('validates raw and fenced NBE settings JSON directly via CodeValidator without demanding HTML', () => {
    const rawJson = JSON.stringify(SETTINGS_A);
    const direct = CodeValidator.validate(rawJson, 'nbe');
    expect(direct.valid).toBe(true);
    expect(direct.errors).toEqual([]);
    expect(JSON.parse(direct.cleanedCode)).toMatchObject({
      layout: 'ring',
      emitters: 5,
      reason: SETTINGS_A.reason,
    });

    const fenced = CodeValidator.validate(`\`\`\`json\n${rawJson}\n\`\`\``, 'nbe');
    expect(fenced.valid).toBe(true);
    expect(fenced.errors).toEqual([]);

    const badJson = CodeValidator.validate(JSON.stringify({ palette: ['red'], layout: 'spiral', reason: '' }), 'nbe');
    expect(badJson.valid).toBe(false);
    expect(badJson.errors.some((e) => e.includes('NBE_SETTINGS: palette must be 3 to 6 hex colours'))).toBe(true);
    expect(badJson.errors.some((e) => e.includes('NBE_SETTINGS: layout must be one of'))).toBe(true);
    expect(badJson.errors.some((e) => e.includes('NBE_SETTINGS: reason must be one sentence'))).toBe(true);

    const truncated = CodeValidator.validate('{"palette":["#000"', 'nbe');
    expect(truncated.valid).toBe(false);
    expect(truncated.errors.some((e) => e.includes('NBE_SETTINGS:'))).toBe(true);
  });
});
