/**
 * LibraryRulesValidator tests — per-library legality rules from the
 * medium-lab specs (culori OKLCH ramps, rapier deterministic stepping,
 * physics body budget), plus false-rejection guards for plain pieces that
 * never touched the libraries.
 */
import { describe, it, expect } from 'vitest';
import {
  LibraryRulesValidator,
  MAX_PHYSICS_CREATION_SITES,
} from '../../../src/core/validators/LibraryRulesValidator.js';
import { CodeValidator } from '../../../src/core/CodeValidator.js';

describe('LibraryRulesValidator', () => {
  describe('culori: build ramps in OKLCH, never hex lerp', () => {
    it('rejects a hand-rolled hexLerp helper in a culori piece', () => {
      const code = `
        const { interpolate, oklch } = culori;
        function hexLerp(a, b, t) { return a; }
        const ramp = interpolate(oklch('#ff0000'), oklch('#0000ff'));
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('OKLCH');
    });

    it("rejects interpolate(a, b, 'rgb') — non-perceptual space argument", () => {
      const code = `
        const { interpolate } = culori;
        const ramp = interpolate('#ff0000', '#0000ff', 'rgb');
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('non-perceptual space');
    });

    it('rejects the named non-perceptual interpolator interpolateRgb', () => {
      const code = `
        import { interpolateRgb } from 'culori';
        const ramp = interpolateRgb('#ff0000', '#0000ff');
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('non-perceptual space');
    });

    it('rejects p5 lerpColor inside a culori piece', () => {
      const code = `
        const { formatHex, oklch } = culori;
        function draw() {
          const c = lerpColor(color('#ff0000'), color('#0000ff'), 0.5);
        }
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('lerpColor');
    });

    it('accepts a clean culori piece interpolating through oklch', () => {
      const code = `
        const { interpolate, oklch, formatHex } = culori;
        const ramp = interpolate(oklch('#ff0000'), oklch('#0000ff'));
        for (let t = 0; t <= 1; t += 0.1) formatHex(ramp(t));
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts lerpColor in a plain p5 piece that never touches culori', () => {
      const code = `
        function setup() { createCanvas(400, 400); }
        function draw() {
          const c = lerpColor(color(255, 0, 0), color(0, 0, 255), 0.5);
          fill(c); circle(200, 200, 100);
        }
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
    });

    it('ignores prose comments that merely mention the banned patterns', () => {
      const code = `
        // build ramps in OKLCH, never hex lerp (hexLerp is forbidden)
        /* world.timestep = dt would break determinism */
        const { interpolate, oklch } = culori;
        const ramp = interpolate(oklch('#ff0000'), oklch('#0000ff'));
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
      // non-vacuous: culori must still be detected so the rules actually ran
      expect(LibraryRulesValidator.detectLibraries(code)).toContain('culori');
    });
  });

  describe('rapier2d: deterministic stepping', () => {
    it('rejects a dynamic world.timestep fed by frame delta', () => {
      const code = `
        import RAPIER from '@dimforge/rapier2d-compat';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        function frame(dt) { world.timestep = dt; world.step(); }
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('fixed timestep');
    });

    it('rejects world.timestep assigned from a clock', () => {
      const code = `
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        world.timestep = clock.getDelta();
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
    });

    it('accepts a fixed timestep held in a named constant (FIXED_DELTA regression)', () => {
      const code = `
        import RAPIER from '@dimforge/rapier2d-compat';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        const FIXED_DELTA = 1 / 60;
        world.timestep = FIXED_DELTA;
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
    });

    it('accepts a fixed timestep with an accumulator loop', () => {
      const code = `
        import RAPIER from '@dimforge/rapier2d-compat';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        world.timestep = 1 / 60;
        let acc = 0;
        function frame(deltaMs) {
          acc += deltaMs / 1000;
          while (acc >= world.timestep) { world.step(); acc -= world.timestep; }
        }
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
    });
  });

  describe('physics body budget', () => {
    it(`rejects more than ${MAX_PHYSICS_CREATION_SITES} unrolled rapier body sites`, () => {
      const bodies = Array.from(
        { length: MAX_PHYSICS_CREATION_SITES + 25 },
        () => 'world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0));',
      ).join('\n');
      const code = `
        import RAPIER from '@dimforge/rapier2d-compat';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        world.timestep = 1 / 60;
        ${bodies}
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('physics budget');
    });

    it('rejects unrolled matter-js body creation over the budget', () => {
      const bodies = Array.from(
        { length: MAX_PHYSICS_CREATION_SITES + 10 },
        (_, i) => `Matter.Bodies.rectangle(${i}, 0, 10, 10);`,
      ).join('\n');
      const code = `
        const { Engine, Bodies } = Matter;
        ${bodies}
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('matter-js');
    });

    it('accepts loop-based matter-js spawning (bounded sites)', () => {
      const code = `
        const { Engine, Bodies, Composite } = Matter;
        const engine = Engine.create();
        for (let i = 0; i < 60; i++) {
          Composite.add(engine.world, Bodies.rectangle(i * 12, 20, 10, 10));
        }
        Engine.update(engine, 16.666);
      `;
      // non-vacuous: matter-js detected through the destructured global, so
      // the budget counter actually ran and found the single loop site legal
      expect(LibraryRulesValidator.detectLibraries(code)).toContain('matter-js');
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
    });
  });

  describe('CodeValidator wiring (LAW 33 — prove the live path)', () => {
    it('surfaces the culori hex-lerp rule through CodeValidator.validate', () => {
      const code = `
        const { interpolate, oklch } = culori;
        function hexLerp(a, b, t) { return a; }
        const ramp = interpolate(oklch('#ff0000'), oklch('#0000ff'));
      `;
      const result = CodeValidator.validate(code);
      expect(result.errors.some(e => e.includes('Library rule (culori)') && e.includes('OKLCH'))).toBe(true);
    });

    it('surfaces the rapier determinism rule through CodeValidator.validate', () => {
      const code = `
        import RAPIER from '@dimforge/rapier2d-compat';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        function frame(dt) { world.timestep = dt; world.step(); }
      `;
      const result = CodeValidator.validate(code);
      expect(result.errors.some(e => e.includes('Library rule (rapier2d)') && e.includes('fixed timestep'))).toBe(true);
    });

    it('surfaces the matter-js budget rule through CodeValidator.validate', () => {
      const bodies = Array.from(
        { length: MAX_PHYSICS_CREATION_SITES + 10 },
        (_, i) => `Matter.Bodies.rectangle(${i}, 0, 10, 10);`,
      ).join('\n');
      const result = CodeValidator.validate(`const { Bodies } = Matter;\n${bodies}`);
      expect(result.errors.some(e => e.includes('Library rule (matter-js)') && e.includes('physics budget'))).toBe(true);
    });
  });
});

describe('GLM-noted follow-ups (2026-09-01 evening)', () => {
  it('rejects the suffix-form dynamic timestep names (frameDelta, deltaTime)', () => {
    for (const name of ['frameDelta', 'deltaTime', 'timeDelta']) {
      const code = `
        import RAPIER from '@dimforge/rapier2d-compat';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        function frame(now) { const ${name} = compute(); world.timestep = ${name}; world.step(); }
      `;
      expect(LibraryRulesValidator.validate(code).valid, name).toBe(false);
    }
  });

  it('still accepts fixed constants in camelCase (fixedDelta stays legal)', () => {
    const code = `
      import RAPIER from '@dimforge/rapier2d-compat';
      const world = new RAPIER.World({ x: 0, y: -9.81 });
      const fixedDelta = 1 / 60;
      world.timestep = fixedDelta;
    `;
    expect(LibraryRulesValidator.validate(code).valid).toBe(true);
  });

  it('a // inside a URL string no longer blanks the rest of the line (real code after URLs survives detection)', () => {
    const code = `
      import RAPIER from 'https://cdn.example.com/@dimforge/rapier2d-compat/rapier.mjs'; const dt = clock(); world.timestep = dt;
    `;
    const result = LibraryRulesValidator.validate(code);
    expect(result.valid).toBe(false); // dt assignment AFTER the URL string must still be caught
    expect(result.errors.some(e => e.includes('fixed timestep'))).toBe(true);
  });

  it('vendored-tag detection survives an https:// URL on the same line', () => {
    const code = `const x = "https://x.test/a"; load('/vendor/rapier2d/rapier.mjs'); const dt = 1; world.timestep = dt;`;
    expect(LibraryRulesValidator.detectLibraries(code)).toContain('rapier2d');
    expect(LibraryRulesValidator.validate(code).valid).toBe(false);
  });
});
