import { describe, expect, it } from 'vitest';
import {
  CRAFT_CONTRACT,
  CRAFT_CONTRACT_COMPACT,
  SVG_CRAFT_CONTRACT,
  SVG_CRAFT_CONTRACT_COMPACT,
  HYDRA_CRAFT_CONTRACT,
  HYDRA_CRAFT_CONTRACT_COMPACT,
  THREE_CRAFT_CONTRACT,
  THREE_CRAFT_CONTRACT_COMPACT,
  P5_CRAFT_CONTRACT,
  P5_CRAFT_CONTRACT_COMPACT,
} from '../../../src/prompts/CraftContract';
import { PromptBuilder } from '../../../src/llm/PromptBuilder';
import { HydraValidator } from '../../../src/core/validators/HydraValidator';
import { P5Validator } from '../../../src/core/validators/P5Validator';

describe('CraftContract', () => {
  it('full contract demands every 0.9-band dimension', () => {
    for (const dim of ['COMPOSITION', 'DEPTH', 'LIGHT', 'PALETTE', 'MOTION', 'NEGATIVE SPACE', 'FINISH']) {
      expect(CRAFT_CONTRACT).toContain(dim);
    }
  });

  it('compact contract stays under a third of the full length', () => {
    expect(CRAFT_CONTRACT_COMPACT.length).toBeLessThan(CRAFT_CONTRACT.length / 3 + 50);
  });
});

describe('CraftContract — SVG', () => {
  it('SVG full contract demands raw <svg> root, no fences, no prose', () => {
    expect(SVG_CRAFT_CONTRACT).toContain('<svg');
    expect(SVG_CRAFT_CONTRACT).toContain('</svg>');
    expect(SVG_CRAFT_CONTRACT).toContain('No markdown fences');
  });

  it('SVG compact contract is shorter and still anchors the root format', () => {
    expect(SVG_CRAFT_CONTRACT_COMPACT.length).toBeLessThan(SVG_CRAFT_CONTRACT.length);
    expect(SVG_CRAFT_CONTRACT_COMPACT).toContain('</svg>');
  });
});

/**
 * REPRO EVIDENCE — novel hydra prompts that an LLM is likely to emit (or that
 * already failed overnight, see ~/.sinter/failures/1781265823171-d607emr4j.json).
 * The validator's substring check originally rejected ANY code containing
 * `.sin(`, including valid `Math.sin(time)` calls inside arrow functions —
 * a false-rejection class fixed deliberately (the Math.* strip in
 * HydraValidator, kill #19: Math inside time-callbacks is legitimate hydra
 * animation; only bare math calls ON SOURCES are invalid). Repros #1/#2 now
 * pin the FIXED behavior: Math.sin variants pass; repro #3 keeps proving the
 * real protection — chained .sin()/.cos()/… methods on sources still reject.
 */
describe('Hydra REPRO — novel prompts validate (raw code → exact validator error)', () => {
  it('repro #1: failure-record code (bioluminescent anemones) with Math.sin PASSES post-fix', () => {
    const codeFromFailureRecord = `gradient(0.2).color(0.01, 0.04, 0.08).brightness(0.7).layer(shape(99, 0.6, 0.001).scale(1, 0.35).repeat(12, 1).rotate(() => Math.sin(time * 0.4) * 0.15 + time * 0.05).color(0.05, 0.65, 0.55).modulate(noise(3, 0.25), 0.35)).blend(osc(4, 0.08, 1.5).color(0.02, 0.35, 0.45).kaleid(8).rotate(() => -time * 0.03).scale(1, 1.2), 0.32).modulate(voronoi(4, 0.18, 0.1), 0.22).saturate(1.25).contrast(1.45).brightness(0.82).out(o0); render(o0);`;
    const r = HydraValidator.validate(codeFromFailureRecord);
    expect(r.valid).toBe(true);
  });

  it('repro #2: novel "murmuration ribbons over slate water" prompt with Math.sin PASSES post-fix', () => {
    const codeForNovelPrompt = `osc(20, 0.05, 1.2).color(0.05, 0.2, 0.4).modulate(noise(2, 0.1).rotate(0.1), 0.4).rotate(0.05, 0.1).scrollX(() => Math.sin(time * 0.2) * 0.1).scale(1.1).modulate(voronoi(3, 0.2), 0.15).saturate(0.9).contrast(1.3).brightness(0.75).out(o0); render(o0);`;
    const r = HydraValidator.validate(codeForNovelPrompt);
    expect(r.valid).toBe(true);
  });

  it('repro #3: chained .sin() / .cos() / .tan() methods are REJECTED', () => {
    for (const method of ['sin', 'cos', 'tan', 'sqrt', 'abs', 'pow']) {
      const code = `osc(20, 0.05, 1.2).${method}(0.5).out(o0); render(o0);`;
      const r = HydraValidator.validate(code);
      expect(r.valid, `chained .${method}(0.5) should be rejected`).toBe(false);
      expect(r.errors.some((e) => e.includes(`.${method}(`))).toBe(true);
    }
  });

  it('counter-evidence: a code that follows the new contract PASSES (no Math, no chained math methods, ends with .out(o0) and render(o0))', () => {
    const code = `solid(0.05, 0.1, 0.2).layer(osc(8, 0.05, 1.5).color(0.6, 0.8, 1.0).kaleid(4).rotate(0, 0.05).modulate(noise(3, 0.1), 0.3)).modulate(voronoi(4, 0.2, 0.1), 0.2).contrast(1.4).brightness(0.85).out(o0); render(o0);`;
    const r = HydraValidator.validate(code);
    expect(r.valid).toBe(true);
  });
});

describe('CraftContract — Hydra (repro-first evidence: validator rejects these substrings)', () => {
  it('hydra full contract forbids Math.* and the validator-rejected substrings', () => {
    expect(HYDRA_CRAFT_CONTRACT).toContain('NEVER use Math.*');
    for (const forbidden of ['.sin(', '.cos(', '.tan(', '.sqrt(', '.abs(', '.pow(', '.saturation(', '.feedback(', '.kaleidoscope(', '.colorShift(', '.post(', '.screen(', '.output(']) {
      expect(HYDRA_CRAFT_CONTRACT).toContain(forbidden);
    }
  });

  it('hydra full contract demands sources, animation args, .out(o0), render(o0)', () => {
    expect(HYDRA_CRAFT_CONTRACT).toContain('osc(freq, sync, offset)');
    expect(HYDRA_CRAFT_CONTRACT).toContain('noise(scale, offset)');
    expect(HYDRA_CRAFT_CONTRACT).toContain('.out(o0)');
    expect(HYDRA_CRAFT_CONTRACT).toContain('render(o0)');
  });

  it('hydra full contract forbids camera/screen input (s0.initCam, s0.initScreen, src(s0))', () => {
    expect(HYDRA_CRAFT_CONTRACT).toContain('s0.initCam()');
    expect(HYDRA_CRAFT_CONTRACT).toContain('s0.initScreen()');
    expect(HYDRA_CRAFT_CONTRACT).toContain('src(s0)');
  });

  it('hydra compact contract is shorter and still enforces the substrings ban', () => {
    expect(HYDRA_CRAFT_CONTRACT_COMPACT.length).toBeLessThan(HYDRA_CRAFT_CONTRACT.length);
    expect(HYDRA_CRAFT_CONTRACT_COMPACT).toContain('Math.*');
    expect(HYDRA_CRAFT_CONTRACT_COMPACT).toContain('.out(o0)');
    expect(HYDRA_CRAFT_CONTRACT_COMPACT).toContain('render(o0)');
  });
});

describe('PromptBuilder.contractFor — single routing point', () => {
  it('routes svg domain to SVG contracts (full vs compact by tier)', () => {
    expect(PromptBuilder.contractFor('svg', 'flagship')).toBe(SVG_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('svg', 'medium')).toBe(SVG_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('svg', 'local')).toBe(SVG_CRAFT_CONTRACT_COMPACT);
    expect(PromptBuilder.contractFor('svg', 'tiny')).toBe(SVG_CRAFT_CONTRACT_COMPACT);
  });

  it('routes hydra domain to HYDRA contracts (full vs compact by tier)', () => {
    expect(PromptBuilder.contractFor('hydra', 'flagship')).toBe(HYDRA_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('hydra', 'medium')).toBe(HYDRA_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('hydra', 'local')).toBe(HYDRA_CRAFT_CONTRACT_COMPACT);
    expect(PromptBuilder.contractFor('hydra', 'tiny')).toBe(HYDRA_CRAFT_CONTRACT_COMPACT);
  });

  it('routes three domain to THREE contracts (full vs compact by tier)', () => {
    expect(PromptBuilder.contractFor('three', 'flagship')).toBe(THREE_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('three', 'medium')).toBe(THREE_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('three', 'local')).toBe(THREE_CRAFT_CONTRACT_COMPACT);
    expect(PromptBuilder.contractFor('three', 'tiny')).toBe(THREE_CRAFT_CONTRACT_COMPACT);
  });

  it('routes p5 domain to P5 contracts (full vs compact by tier)', () => {
    expect(PromptBuilder.contractFor('p5', 'flagship')).toBe(P5_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('p5', 'medium')).toBe(P5_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('p5', 'local')).toBe(P5_CRAFT_CONTRACT_COMPACT);
    expect(PromptBuilder.contractFor('p5', 'tiny')).toBe(P5_CRAFT_CONTRACT_COMPACT);
  });

  it('falls back to the generic CRAFT_CONTRACT for every other domain (unchanged behavior)', () => {
    for (const tier of ['flagship', 'medium', 'local', 'tiny'] as const) {
      expect(PromptBuilder.contractFor('shader', tier)).toBe(
        tier === 'local' || tier === 'tiny' ? CRAFT_CONTRACT_COMPACT : CRAFT_CONTRACT,
      );
      expect(PromptBuilder.contractFor('tone', tier)).toBe(
        tier === 'local' || tier === 'tiny' ? CRAFT_CONTRACT_COMPACT : CRAFT_CONTRACT,
      );
      expect(PromptBuilder.contractFor('strudel', tier)).toBe(
        tier === 'local' || tier === 'tiny' ? CRAFT_CONTRACT_COMPACT : CRAFT_CONTRACT,
      );
      expect(PromptBuilder.contractFor('processing', tier)).toBe(
        tier === 'local' || tier === 'tiny' ? CRAFT_CONTRACT_COMPACT : CRAFT_CONTRACT,
      );
    }
  });

  it('is case-insensitive and tolerant of whitespace on the domain', () => {
    expect(PromptBuilder.contractFor('SVG', 'flagship')).toBe(SVG_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('  Hydra ', 'tiny')).toBe(HYDRA_CRAFT_CONTRACT_COMPACT);
    expect(PromptBuilder.contractFor('HYDRA', 'medium')).toBe(HYDRA_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('THREE', 'flagship')).toBe(THREE_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('  three ', 'tiny')).toBe(THREE_CRAFT_CONTRACT_COMPACT);
    expect(PromptBuilder.contractFor('P5', 'flagship')).toBe(P5_CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('  p5 ', 'tiny')).toBe(P5_CRAFT_CONTRACT_COMPACT);
  });

  it('treats undefined / empty domain as the generic fallback (unchanged behavior)', () => {
    expect(PromptBuilder.contractFor(undefined, 'flagship')).toBe(CRAFT_CONTRACT);
    expect(PromptBuilder.contractFor('', 'tiny')).toBe(CRAFT_CONTRACT_COMPACT);
  });
});

describe('PromptBuilder craft wiring', () => {
  const ctx = { userRequest: 'a tide pool', domain: 'shader' };

  it('flagship and medium tiers carry the full contract', () => {
    for (const model of ['claude-opus-4-5', 'gpt-5']) {
      const built = new PromptBuilder({ baseUrl: '', model }).build(ctx);
      expect(built.system).toContain('<craft_contract>');
      expect(built.system).toContain('COMPOSITION: one dominant focal point');
    }
  });

  it('local tier carries the compact contract', () => {
    const built = new PromptBuilder({ baseUrl: 'http://localhost:11434', model: 'llama3:8b' }).build(ctx);
    expect(built.system).toContain('<craft_contract>');
    expect(built.system).toContain('Exhibition grade required');
  });

  it('hydra domain routes to HYDRA_CRAFT_CONTRACT on flagship tier (NEW behavior)', () => {
    const built = new PromptBuilder({ baseUrl: '', model: 'claude-opus-4-5' }).build({
      userRequest: 'a murmuration of ribbons over slate water',
      domain: 'hydra',
    });
    expect(built.system).toContain('<craft_contract domain="hydra">');
    expect(built.system).toContain('NEVER use Math.*');
    expect(built.system).toContain('.out(o0)');
    expect(built.system).toContain('render(o0)');
  });

  it('hydra domain routes to HYDRA_CRAFT_CONTRACT_COMPACT on local tier (NEW behavior)', () => {
    const built = new PromptBuilder({ baseUrl: 'http://localhost:11434', model: 'llama3:8b' }).build({
      userRequest: 'bioluminescent anemones breathing with the cursor',
      domain: 'hydra',
    });
    expect(built.system).toContain('<craft_contract domain="hydra">');
    expect(built.system).toContain('Math.*');
  });

  it('svg domain still routes to SVG_CRAFT_CONTRACT on flagship tier (regression)', () => {
    const built = new PromptBuilder({ baseUrl: '', model: 'claude-opus-4-5' }).build({
      userRequest: 'a tide pool',
      domain: 'svg',
    });
    expect(built.system).toContain('<craft_contract domain="svg">');
    expect(built.system).toContain('<svg');
    expect(built.system).toContain('</svg>');
  });

  it('default domains (shader, tone, …) still get the generic contract', () => {
    for (const domain of ['shader', 'tone', 'strudel', 'processing']) {
      const built = new PromptBuilder({ baseUrl: '', model: 'claude-opus-4-5' }).build({
        userRequest: 'a tide pool',
        domain,
      });
      expect(built.system).toContain('COMPOSITION: one dominant focal point');
      expect(built.system).not.toContain('domain="hydra"');
      expect(built.system).not.toContain('domain="svg"');
      expect(built.system).not.toContain('domain="three"');
      expect(built.system).not.toContain('domain="p5"');
    }
  });

  it('three domain routes to THREE_CRAFT_CONTRACT with exposure discipline (W6a)', () => {
    const built = new PromptBuilder({ baseUrl: '', model: 'claude-opus-4-5' }).build({
      userRequest: 'a rotating cube with visible lighting',
      domain: 'three',
    });
    expect(built.system).toContain('<craft_contract domain="three">');
    expect(built.system).toContain('ACESFilmicToneMapping');
    expect(built.system).toContain('0.8-2.0');
    expect(built.system).toContain('never Math.PI');
  });

  it('p5 domain routes to P5_CRAFT_CONTRACT with luminosity floor (W6c)', () => {
    const built = new PromptBuilder({ baseUrl: '', model: 'claude-opus-4-5' }).build({
      userRequest: 'blue green particles with visible motion',
      domain: 'p5',
    });
    expect(built.system).toContain('<craft_contract domain="p5">');
    expect(built.system).toContain('≥120 elements');
    expect(built.system).toContain('soft glow');
    expect(built.user).toContain('p5 consistency floor');
  });
});

describe('CraftContract — Three (W6a exposure discipline)', () => {
  it('three full contract requires tone mapping and light intensity bounds', () => {
    expect(THREE_CRAFT_CONTRACT).toContain('ACESFilmicToneMapping');
    expect(THREE_CRAFT_CONTRACT).toContain('0.25-0.6');
    expect(THREE_CRAFT_CONTRACT).toContain('0.8-2.0');
    expect(THREE_CRAFT_CONTRACT).toContain('Never intensity ≥ 3.0');
    expect(THREE_CRAFT_CONTRACT).toContain('never Math.PI');
  });

  it('three compact contract is shorter and still enforces exposure bounds', () => {
    expect(THREE_CRAFT_CONTRACT_COMPACT.length).toBeLessThan(THREE_CRAFT_CONTRACT.length);
    expect(THREE_CRAFT_CONTRACT_COMPACT).toContain('ACESFilmicToneMapping');
    expect(THREE_CRAFT_CONTRACT_COMPACT).toContain('intensity ≥ 3');
  });
});

describe('CraftContract — p5 (W6c consistency floor)', () => {
  it('p5 full contract requires full-canvas density and luminosity on dark grounds', () => {
    expect(P5_CRAFT_CONTRACT).toContain('full viewport');
    expect(P5_CRAFT_CONTRACT).toContain('≥120 elements');
    expect(P5_CRAFT_CONTRACT).toContain('soft glow');
    expect(P5_CRAFT_CONTRACT).toContain('Dim-on-near-black');
    expect(P5_CRAFT_CONTRACT).toContain('focal structure');
  });

  it('p5 compact contract is shorter and still enforces density + glow', () => {
    expect(P5_CRAFT_CONTRACT_COMPACT.length).toBeLessThan(P5_CRAFT_CONTRACT.length);
    expect(P5_CRAFT_CONTRACT_COMPACT).toContain('≥120');
    expect(P5_CRAFT_CONTRACT_COMPACT).toContain('soft glow');
  });

  it('rejects beauty-campaign dim-sparse shapes (run1 count, run3 life alpha)', () => {
    const run1 = `
      let particles = [];
      const NUM_PARTICLES = 80;
      class Particle {
        constructor() {
          this.x = 0; this.y = 0;
          this.size = random(2, 9);
          this.alpha = map(this.size, 2, 9, 80, 230);
        }
        display() { fill(30, 180, 170, this.alpha); ellipse(this.x, this.y, this.size); }
      }
      function setup() {
        createCanvas(800, 600);
        for (let i = 0; i < NUM_PARTICLES; i++) particles.push(new Particle());
      }
      function draw() {
        background(6, 12, 22);
        for (const p of particles) p.display();
      }
    `;
    const r1 = P5Validator.validate(run1);
    expect(r1.valid).toBe(false);
    expect(r1.errors.some((e) => e.includes('sparse') || e.includes('luminosity') || e.includes('soft glow'))).toBe(true);

    const run3 = `
      let particles = [];
      const NUM = 120;
      class Particle {
        constructor() {
          this.x = 0; this.y = 0;
          this.life = 200; this.maxLife = 200; this.r = 4;
        }
        show() {
          let a = map(this.life, 0, this.maxLife, 0, 85);
          fill(180, 70, 60, a);
          ellipse(this.x, this.y, this.r * 2);
          if (random() < 0.08) ellipse(this.x, this.y, this.r * 3.5);
        }
      }
      function setup() {
        createCanvas(800, 800);
        colorMode(HSB, 360, 100, 100, 100);
        for (let i = 0; i < NUM; i++) particles.push(new Particle());
      }
      function draw() {
        background(220, 80, 7);
        for (const p of particles) p.show();
      }
    `;
    const r3 = P5Validator.validate(run3);
    expect(r3.valid).toBe(false);
    expect(r3.errors.some((e) => e.includes('life alpha') || e.includes('luminosity') || e.includes('soft glow'))).toBe(true);
  });

  it('accepts luminous full-field particle pattern (run2 shape)', () => {
    const run2 = `
      let particles = [];
      const NUM_PARTICLES = 120;
      const BG = [8, 18, 28];
      class Particle {
        constructor() {
          this.size = random(3, 14);
          this.alpha = map(this.size, 3, 14, 140, 255);
          this.pos = createVector(0, 0);
        }
        display() {
          fill(0, 180, 160, this.alpha);
          ellipse(this.pos.x, this.pos.y, this.size, this.size);
          if (this.size > 8) {
            fill(0, 180, 160, this.alpha * 0.15);
            ellipse(this.pos.x, this.pos.y, this.size * 2.2, this.size * 2.2);
          }
        }
      }
      function setup() {
        createCanvas(800, 800);
        for (let i = 0; i < NUM_PARTICLES; i++) particles.push(new Particle());
      }
      function draw() {
        background(BG[0], BG[1], BG[2]);
        for (const p of particles) p.display();
      }
    `;
    const r = P5Validator.validate(run2);
    expect(r.valid).toBe(true);
  });
});
