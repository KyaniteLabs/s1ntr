import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

import {
  buildCreativeDomainRouteTruth,
  buildCreativeDomainPlan,
  detectPreviewDomainForCode,
  inferCreativeDomain,
  previewDomainForCode,
  validateGeneratedDomainForRequest,
} from '../../../src/tui-bridge/CreativeDomainRouting.js';
import { Domain } from '../../../src/types/domains.js';

describe('TuiBridgeService creative domain routing', () => {
  it('honors explicit p5 prompts even when visual wording sounds three-dimensional', () => {
    const prompt = 'Create a concise p5.js sketch: luminous blue-green particles orbit a dark center, with visible motion, setup(), draw(), and createCanvas().';

    expect(inferCreativeDomain(prompt)).toBe(Domain.P5);
    expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.P5]);
  });

  it('keeps the p5 generation instruction from accidentally retriggering Three dispatch', () => {
    const source = fs.readFileSync('src/tui-bridge/CreativeIntentHelpers.ts', 'utf8');
    const p5Instruction = source.match(/Return raw p5\.js sketch code only\.[^']+/)?.[0] ?? '';

    expect(p5Instruction).toContain('p5.js sketch code only');
    expect(p5Instruction).not.toContain('SVG');
    expect(p5Instruction).not.toContain('Three.js');
  });

  it('routes explicit Three.js prompts to Three instead of p5 or svg', () => {
    const prompt = 'Generate a Three.js scene: an impossible greenhouse orbiting inside a black hole with glass flowers.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.THREE);
    expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.THREE]);
  });

  it('keeps explicit GLSL prompts locked to shader even when forbidding Three.js', () => {
    const prompt = 'Create a GLSL fragment shader with uv coordinates and animated plasma colors. Do not use p5 or Three.js.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.GLSL);
    expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.GLSL]);
  });

  it('preserves visual fallback options for implicit visual prompts', () => {
    const prompt = 'Create luminous blue-green particles orbiting a dark center with visible motion.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.THREE);
    expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.THREE, Domain.P5, Domain.HYDRA, Domain.GLSL]);
  });

  it('routes SVG prompts to the SVG medium, not a Three/p5 visual fallback (Sol G12)', () => {
    const prompt = 'single line svg of a flower';

    expect(inferCreativeDomain(prompt)).toBe(Domain.SVG);
    expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.SVG]);
  });

  it('treats ASCII and text-art prompts as explicit ASCII requests', () => {
    for (const prompt of ['make ASCII text art of a willow tree', 'make text art of a willow tree']) {
      expect(inferCreativeDomain(prompt)).toBe(Domain.ASCII);
      expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.ASCII]);
    }
  });

  it('routes explicit Tone oscillator prompts to Tone before generic Hydra oscillator handling', () => {
    const prompt = 'Create a Tone.js oscillator synth with delay and a slow drone.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.TONE);
    expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.TONE]);
  });

  it('treats web audio prompts as explicit Tone requests', () => {
    const prompt = 'Build a web audio sequencer with a warm bass pulse.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.TONE);
    expect(buildCreativeDomainPlan(prompt)).toEqual([Domain.TONE]);
  });

  it('routes explicit Hydra video synth prompts to Hydra before generic Tone synth handling', () => {
    const prompt = 'Create a Hydra video synth sketch. User prompt: make a hydra visual of icebergs dancing in the sky.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.HYDRA);
    expect(buildCreativeDomainPlan(prompt)[0]).toBe(Domain.HYDRA);
  });

  it('records prompt-locked route truth for explicit domain prompts', () => {
    const route = buildCreativeDomainRouteTruth('make a hydra visual of icebergs dancing in the sky');

    expect(route).toEqual({
      requestedDomain: Domain.HYDRA,
      selectedDomain: Domain.HYDRA,
      domains: [Domain.HYDRA],
      promptDomainLocked: true,
      source: 'prompt',
    });
  });

  it('records inferred route truth with fallback domains for implicit visuals', () => {
    const route = buildCreativeDomainRouteTruth('luminous particles orbiting a dark center');

    expect(route.requestedDomain).toBe(Domain.THREE);
    expect(route.selectedDomain).toBe(Domain.THREE);
    expect(route.promptDomainLocked).toBe(false);
    expect(route.source).toBe('inferred');
    expect(route.domains).toEqual([Domain.THREE, Domain.P5, Domain.HYDRA, Domain.GLSL]);
  });





  it('no longer routes Revideo prompts to a revideo domain (export engine, not an art domain)', () => {
    for (const prompt of [
      'Create a Revideo composition: a 4-second cinematic title card saying LIMINAL REVIDEO.',
      'Create an @revideo title-card composition with layered animated captions.',
    ]) {
      expect(inferCreativeDomain(prompt) as string).not.toBe('revideo');
      expect(buildCreativeDomainPlan(prompt).map(String)).not.toContain('revideo');
    }
  });

  it('rejects generated Three.js when the prompt locked the route to p5', () => {
    const threeCode = 'import * as THREE from "three"; const scene = new THREE.Scene();';
    const validation = validateGeneratedDomainForRequest(threeCode, Domain.P5);

    expect(validation.ok).toBe(false);
    expect(validation.detected).toBe('three');
    expect(validation.message).toContain('requested p5, generated three');
  });

  it('accepts p5 code when the prompt locked the route to p5', () => {
    const p5Code = 'function setup() { createCanvas(800, 600); } function draw() { ellipse(mouseX, mouseY, 20); }';

    expect(validateGeneratedDomainForRequest(p5Code, Domain.P5)).toMatchObject({ ok: true, detected: 'p5' });
  });


  it('routes explicit Kinetic typography prompts away from the p5-only instruction path', () => {
    const prompt = 'Create CSS kinetic typography as a complete animated HTML artifact.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.KINETIC);
    expect(buildCreativeDomainPlan(prompt)[0]).toBe(Domain.KINETIC);
  });

  it('routes moving type prompts to Kinetic when no explicit framework is requested', () => {
    const prompt = 'Create moving type with expressive letter spacing as a complete animated HTML artifact.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.KINETIC);
    expect(buildCreativeDomainPlan(prompt)[0]).toBe(Domain.KINETIC);
  });

  it('honors explicit Three.js cues before broad kinetic typography matching', () => {
    const prompt = 'Create a Three.js scene with animated text orbiting the camera.';

    expect(inferCreativeDomain(prompt)).toBe(Domain.THREE);
    expect(buildCreativeDomainPlan(prompt)[0]).toBe(Domain.THREE);
  });

  it('still previews HyperFrames HTML (export engine) by detected code', () => {
    const hyperframesCode = '<!doctype html><html><body><div data-composition-id="demo"><h1 class="clip" data-start="0" data-duration="3" data-track-index="0">Title</h1></div><script>const tl = gsap.timeline({ paused: true }); window.__timelines = { demo: tl };</script></body></html>';

    expect(previewDomainForCode(hyperframesCode, Domain.P5)).toBe('hyperframes');
  });

  it('chooses preview domain from actual output code over requested fallback domain', () => {
    const threeCode = 'const scene = new THREE.Scene(); const renderer = new THREE.WebGLRenderer(); renderer.render(scene, new THREE.PerspectiveCamera());';

    expect(detectPreviewDomainForCode(threeCode)).toBe('three');
    expect(previewDomainForCode(threeCode, Domain.P5)).toBe('three');
  });

  it('falls back to the requested preview domain when code is ambiguous', () => {
    const partialCode = '/* sparse partial output; no executable framework markers yet */';

    expect(detectPreviewDomainForCode(partialCode)).toBeUndefined();
    expect(previewDomainForCode(partialCode, Domain.GLSL)).toBe('shader');
    expect(previewDomainForCode(partialCode, Domain.TONE)).toBe('tone');
  });


  it('keeps complete Tone HTML in the Tone preview shell for explicit Tone requests', () => {
    const toneHtml = '<!DOCTYPE html><html><head><script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script></head><body><button>Start</button><script>Tone.Transport.bpm.value = 90;</script></body></html>';

    expect(previewDomainForCode(toneHtml, Domain.TONE)).toBe('tone');
    expect(validateGeneratedDomainForRequest(toneHtml, Domain.TONE)).toMatchObject({ ok: true, detected: 'tone' });
  });

  it('does not include unreachable glsl preview branches for shader output', () => {
    const shaderCode = 'precision mediump float; uniform vec2 u_resolution; void main() { gl_FragColor = vec4(1.0); }';

    expect(previewDomainForCode(shaderCode, Domain.GLSL)).toBe('shader');
  });

  // Sol G12: the conversational route must agree with the direct --domain route on the medium.
  it.each([
    ['an SVG logo with a blue bird', Domain.SVG],
    ['a vector icon of a lighthouse', Domain.SVG],
    ['a blender render of a glass cube', Domain.BLENDER],
    ['a d3 chart of tide heights', Domain.DATAVIZ],
    ['an nbe neural bloom of coral', Domain.NBE],
  ])('routes "%s" to %s and locks it', (prompt, domain) => {
    const route = buildCreativeDomainRouteTruth(prompt);
    expect(route.selectedDomain).toBe(domain);
    expect(route.promptDomainLocked).toBe(true);
    expect(route.domains).toEqual([domain]);
  });
  it('a named framework still beats a loose vector/logo word', () => {
    expect(inferCreativeDomain('a three.js scene with a logo on the wall')).toBe(Domain.THREE);
  });
});
