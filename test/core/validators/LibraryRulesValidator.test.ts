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
  VENDORED_LIBRARY_EXPORTS,
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
        import RAPIER from 'rapier2d';
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
        import RAPIER from 'rapier2d';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        const FIXED_DELTA = 1 / 60;
        world.timestep = FIXED_DELTA;
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
    });

    it('accepts a fixed timestep with an accumulator loop', () => {
      const code = `
        import RAPIER from 'rapier2d';
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
        import RAPIER from 'rapier2d';
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
        import RAPIER from 'rapier2d';
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
      );
      const result = CodeValidator.validate(`const { Bodies } = Matter;\n${bodies}`);
      expect(result.errors.some(e => e.includes('Library rule (matter-js)') && e.includes('physics budget'))).toBe(true);
    });
  });

  describe('holospot: the kit draws the frame', () => {
    const CANONICAL_PIECE = `
      import * as THREE from "three";
      import { Holo, shotCamera, shotRotation } from "holospot";
      const renderer = new THREE.WebGLRenderer();
      renderer.setSize(innerWidth, innerHeight);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(22, innerWidth / innerHeight, 0.1, 100);
      const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.34, 220, 36), new THREE.MeshStandardMaterial());
      scene.add(mesh);
      const holo = new Holo(renderer, { background: "black" });
      holo.apply(mesh, { material: "nebula", sizeMm: 120 });
      const obj = holo.get(mesh);
      await obj.ready;
      shotCamera(camera, obj, { aspect: innerWidth / innerHeight });
      mesh.rotation.copy(shotRotation(obj.pose));
      renderer.setAnimationLoop(() => { mesh.rotation.y += 0.003; holo.render(scene, camera); });
    `;

    it('accepts the canonical holospot piece (apply + holo.render only)', () => {
      // non-vacuous: holospot detected through the import specifier
      expect(LibraryRulesValidator.detectLibraries(CANONICAL_PIECE)).toContain('holospot');
      const result = LibraryRulesValidator.validate(CANONICAL_PIECE);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects a holospot piece that never calls holo.apply/holo.card (the foil is never applied)', () => {
      const code = CANONICAL_PIECE.replace(/\s*holo\.apply\(mesh, \{ material: "nebula", sizeMm: 120 \}\);/, '');
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Library rule (holospot)') && e.includes('holo.apply'))).toBe(true);
    });

    it('rejects a holospot import that never constructs Holo at all', () => {
      const code = `
        import * as THREE from "three";
        import { Holo } from "holospot";
        const renderer = new THREE.WebGLRenderer();
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera();
        renderer.setAnimationLoop(() => renderer.render(scene, camera));
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Library rule (holospot)') && e.includes('holo.apply'))).toBe(true);
    });

    it('accepts holo.card as the apply-equivalent (paper-card piece)', () => {
      const code = CANONICAL_PIECE.replace(
        /holo\.apply\(mesh, \{ material: "nebula", sizeMm: 120 \}\);/,
        'const card = holo.card({ material: "emboss" }); scene.add(card);',
      );
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects calling both holo.render and renderer.render for the frame', () => {
      const code = CANONICAL_PIECE.replace(
        /renderer\.setAnimationLoop\(\(\) => \{ mesh\.rotation\.y \+= 0\.003; holo\.render\(scene, camera\); \}\);/,
        'renderer.setAnimationLoop(() => { mesh.rotation.y += 0.003; holo.render(scene, camera); renderer.render(scene, camera); });',
      );
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Library rule (holospot)') && e.includes('renderer.render'))).toBe(true);
    });

    it('catches the render conflict when the renderer is renamed (gl)', () => {
      const code = CANONICAL_PIECE.replace(/renderer/g, 'gl').replace(
        /gl\.setAnimationLoop\(\(\) => \{ mesh\.rotation\.y \+= 0\.003; holo\.render\(scene, camera\); \}\);/,
        'gl.setAnimationLoop(() => { holo.render(scene, camera); gl.render(scene, camera); });',
      );
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('renderer.render'))).toBe(true);
    });

    it('does not mistake renderer.setAnimationLoop for a renderer.render call', () => {
      // the canonical piece contains renderer.setAnimationLoop — already asserted valid above;
      // make it explicit that the loop-start idiom alone never trips the rule
      const result = LibraryRulesValidator.validate(CANONICAL_PIECE);
      expect(result.errors.some(e => e.includes('renderer.render'))).toBe(false);
    });

    it('warns (without failing) on MeshPhysicalMaterial iridescence in a holospot piece', () => {
      const code = `${CANONICAL_PIECE}
        const fake = new THREE.MeshPhysicalMaterial({ iridescence: 0.9, iridescenceIOR: 1.3 });
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some(w => w.includes('Library rule (holospot)') && w.includes('iridescence'))).toBe(true);
    });

    it('does not warn on iridescence in a plain three piece that never touches holospot', () => {
      const code = `
        const mat = new THREE.MeshPhysicalMaterial({ iridescence: 0.9, metalness: 1 });
        const geo = new THREE.TorusGeometry(1, 0.3, 32, 64);
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('ignores prose comments that mention the banned shapes in a holospot piece', () => {
      const code = `
        // never also renderer.render, and do not fake it with iridescence
        ${CANONICAL_PIECE}
      `;
      const result = LibraryRulesValidator.validate(code);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('surfaces the holospot rules through CodeValidator.validate (LAW 33 — the live path)', () => {
      const code = CANONICAL_PIECE.replace(
        /renderer\.setAnimationLoop\(\(\) => \{ mesh\.rotation\.y \+= 0\.003; holo\.render\(scene, camera\); \}\);/,
        'renderer.setAnimationLoop(() => { holo.render(scene, camera); renderer.render(scene, camera); });',
      );
      const result = CodeValidator.validate(code, 'three');
      expect(result.errors.some(e => e.includes('Library rule (holospot)') && e.includes('renderer.render'))).toBe(true);
    });
  });
});

describe('GLM-noted follow-ups (2026-09-01 evening)', () => {
  it('rejects the suffix-form dynamic timestep names (frameDelta, deltaTime)', () => {
    for (const name of ['frameDelta', 'deltaTime', 'timeDelta']) {
      const code = `
        import RAPIER from 'rapier2d';
        const world = new RAPIER.World({ x: 0, y: -9.81 });
        function frame(now) { const ${name} = compute(); world.timestep = ${name}; world.step(); }
      `;
      expect(LibraryRulesValidator.validate(code).valid, name).toBe(false);
    }
  });

  it('still accepts fixed constants in camelCase (fixedDelta stays legal)', () => {
    const code = `
      import RAPIER from 'rapier2d';
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

  describe('imported names must exist in the vendored library (v7: invented `studio` export)', () => {
    const body = `
      const holo = new Holo(renderer, { background: 'black' });
      const obj = holo.apply(mesh, { material: 'prism' });
      await obj.ready;
      FRAME(camera, obj, { aspect: 1 });
      renderer.setAnimationLoop(() => holo.render(scene, camera));
    `;

    it('rejects import { studio } from "holospot"', () => {
      const result = LibraryRulesValidator.validate(`import { Holo, studio } from "holospot";\n${body.replace('FRAME', 'shotCamera')}\nstudio.preset(holo, "studio");`);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toMatch(/studio.*not exported.*holospot/s);
      expect(result.errors.join('\n')).toContain('holo.setScene');
    });

    it('passes the real export names, including aliases and multi-line lists', () => {
      const code = `import {\n  Holo,\n  shotCamera as sc,\n  shotRotation,\n} from 'holospot';\n${body.replace('FRAME', 'sc')}`;
      expect(LibraryRulesValidator.validate(code).valid).toBe(true);
    });

    it('passes namespace imports and the setScene call', () => {
      const code = `import * as K from "holospot";\nconst holo = new K.Holo(renderer);\nconst o = holo.apply(m, {});\nawait o.ready;\nK.shotCamera(camera, o, { aspect: 1 });\nholo.setScene({"studio.preset": "studio"});`;
      expect(LibraryRulesValidator.validate(code).valid).toBe(true);
    });

    it('ignores a commented-out bad import', () => {
      const code = `import { Holo, shotCamera } from "holospot";\n// import { studio } from "holospot";\n${body.replace('FRAME', 'shotCamera')}`;
      expect(LibraryRulesValidator.validate(code).valid).toBe(true);
    });

    it('drift guard: the export list matches the vendored dist export clause', async () => {
      const { readFileSync } = await import('node:fs');
      const src = readFileSync('vendor/holospot/0.1.0/dist/holo.js', 'utf8');
      const clause = [...src.matchAll(/export\s*\{([^}]*)\}/g)].pop()![1];
      const names = clause.split(',').map(x => x.trim().split(/\s+as\s+/).pop()!).filter(Boolean).sort();
      expect([...VENDORED_LIBRARY_EXPORTS.holospot].sort()).toEqual(names);
    });
  });
  describe('holospot: the kit frames the hero (v8: 3 of 4 hand-framed pieces cropped)', () => {
    const page = (frame: string, imp = '{ Holo, shotCamera }') => `import ${imp} from "holospot";
const holo = new Holo(renderer, { background: "black" });
const obj = holo.apply(hero, { material: "prism", sizeMm: 80 });
await obj.ready;
${frame}
renderer.setAnimationLoop(() => holo.render(scene, camera));`;

    it('rejects a hand-placed camera and names shotCamera', () => {
      const r = LibraryRulesValidator.validate(page('camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);', '{ Holo }'));
      expect(r.valid).toBe(false);
      expect(r.errors.join('\n')).toMatch(/framed by hand.*await obj\.ready; shotCamera\(camera, obj/s);
    });

    it('rejects shotCamera that is imported but never called', () => {
      const r = LibraryRulesValidator.validate(page('// shotCamera(camera, hero)'));
      expect(r.errors.some(e => e.includes('framed by hand'))).toBe(true);
    });

    it('accepts a direct, aliased or namespaced shotCamera call', () => {
      const direct = page('shotCamera(camera, obj, { aspect: innerWidth / innerHeight });');
      const aliased = page('frame(camera, obj, { aspect: 1 });', '{ Holo, shotCamera as frame }');
      const ns = `import * as K from "holospot";\nconst holo = new K.Holo(renderer);\nconst obj = holo.apply(hero, {});\nobj.ready.then(() => K.shotCamera(camera, obj, { aspect: 1 }));\nrenderer.setAnimationLoop(() => holo.render(scene, camera));`;
      for (const code of [direct, aliased, ns]) {
        expect(LibraryRulesValidator.validate(code).errors.filter(e => e.includes('framed by hand'))).toEqual([]);
      }
    });

    it('rejects shotCamera given the bare mesh (v10: "needs the object to be ready")', () => {
      const r = LibraryRulesValidator.validate(page('shotCamera(camera, hero, { aspect: 1 });'));
      expect(r.valid).toBe(false);
      expect(r.errors.join('\n')).toMatch(/shotCamera\(camera, hero\) frames before the kit is ready.*await obj\.ready/s);
    });

    it('rejects shotCamera on the holo object before its ready promise is awaited', () => {
      const code = page('shotCamera(camera, obj, { aspect: 1 });').replace('await obj.ready;\n', '');
      expect(LibraryRulesValidator.validate(code).errors.join('\n')).toContain('shotCamera(camera, obj) frames before the kit is ready');
    });

    it('rejects framing the mesh holo.card returns and names holo.get (v11: the card rendered black)', () => {
      const code = `import { Holo, shotCamera } from "holospot";
const holo = new Holo(renderer, { background: "black" });
const card = holo.card({ material: "shatter", widthMm: 63, heightMm: 88 });
scene.add(card);
await card.ready;
shotCamera(camera, card, { aspect: 1 });
renderer.setAnimationLoop(() => holo.render(scene, camera));`;
      const r = LibraryRulesValidator.validate(code);
      expect(r.valid).toBe(false);
      expect(r.errors.join('\n')).toMatch(/shotCamera\(camera, card\) frames before the kit is ready.*holo\.get\(cardMesh\)/s);
      const fixed = code.replace('await card.ready;\nshotCamera(camera, card,', 'const obj = holo.get(card);\nawait obj.ready;\nshotCamera(camera, obj,');
      expect(LibraryRulesValidator.validate(fixed).errors.filter(e => e.includes('before the kit is ready'))).toEqual([]);
    });

    it('accepts every frame call once the kit object is ready', () => {
      const r = LibraryRulesValidator.validate(page('shotCamera(camera, obj, { aspect: 1 });\naddEventListener("resize", () => shotCamera(camera, obj, { aspect: innerWidth / innerHeight }));'));
      expect(r.errors.filter(e => e.includes('before the kit is ready'))).toEqual([]);
    });
  });

  describe('imports: a specifier with no library card renders a blank page', () => {
    it('rejects an unknown bare specifier and names it', () => {
      const result = LibraryRulesValidator.validate(`import * as _ from "lodash";\nconsole.log(_);`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('"lodash"') && e.includes('Library rule (imports)'))).toBe(true);
    });

    it('names the specifier in a dynamic import() too', () => {
      const result = LibraryRulesValidator.validate(`const m = await import("lodash");`);
      expect(result.errors.some(e => e.includes('"lodash"'))).toBe(true);
    });

    it('skips the check for domains that never run in a wrapped page (revideo, blender)', () => {
      const code = `import { makeScene2D } from "@revideo/2d";`;
      expect(LibraryRulesValidator.validate(code, 'revideo').errors).toEqual([]);
      expect(LibraryRulesValidator.validate(code, 'p5').errors.length).toBeGreaterThan(0);
    });

    it('accepts vendored ids, three and relative specifiers', () => {
      const code = `import * as THREE from "three";\nimport { oklch } from "culori";\nimport x from "./x.js";`;
      expect(LibraryRulesValidator.validate(code).errors.filter(e => e.includes('(imports)'))).toEqual([]);
    });
  });

  describe('holospot: option names match the kit API (holo.d.ts ApplyOptions/CardOptions)', () => {
    const wrap = (call: string) => `import { Holo, shotCamera } from "holospot";
const holo = new Holo(renderer);
${call}
const obj = holo.get(mesh);
await obj.ready;
shotCamera(camera, obj, { aspect: 1 });
renderer.setAnimationLoop(() => holo.render(scene, camera));`;

    it('rejects sizeMm on holo.card and says what card takes', () => {
      const r = LibraryRulesValidator.validate(wrap('const card = holo.card({ material: "emboss", sizeMm: 88 });'));
      expect(r.valid).toBe(false);
      const e = r.errors.find(x => x.includes('sizeMm')) ?? '';
      expect(e).toContain('holo.card');
      expect(e).toContain('widthMm');
    });

    it('rejects an invented option on holo.apply', () => {
      const r = LibraryRulesValidator.validate(wrap('holo.apply(mesh, { material: "prism", sizeMillimetres: 80 });'));
      expect(r.errors.some(x => x.includes('sizeMillimetres') && x.includes('holo.apply'))).toBe(true);
    });

    it('accepts the real options, including quoted keys, nested settings and spread', () => {
      const ok1 = wrap('holo.apply(mesh, { material: "nebula", sizeMm: 120, settings: { "nebula.baseColor": "#101030", foo: 1 }, structureScale: 2 });');
      const ok2 = wrap('const c = holo.card({ material: "emboss", widthMm: 63, heightMm: 88, size: 2, settings: { "emboss.logo": "/l.svg" } });');
      const ok3 = wrap('holo.apply(mesh, { ...opts, "material": "prism" });');
      for (const code of [ok1, ok2, ok3]) {
        expect(LibraryRulesValidator.validate(code).errors).toEqual([]);
      }
    });

    it('checks a renamed Holo instance and ignores unrelated .apply calls', () => {
      const renamed = `import { Holo } from "holospot";
const kit = new Holo(renderer);
kit.card({ material: "emboss", sizeMm: 88 });
kit.render(scene, camera);`;
      expect(LibraryRulesValidator.validate(renamed).errors.some(x => x.includes('sizeMm'))).toBe(true);
      const unrelated = wrap('holo.apply(mesh, { material: "prism" }); fn.apply(this, { bogus: 1 });');
      expect(LibraryRulesValidator.validate(unrelated).errors).toEqual([]);
    });

    it('is reachable through CodeValidator.validate (the live path)', () => {
      const r = CodeValidator.validate(wrap('holo.card({ material: "emboss", sizeMm: 88 });'), 'three');
      expect(r.errors.some(x => x.includes('sizeMm'))).toBe(true);
    });

    it('exported option lists name only options the vendored kit reads', async () => {
      const { readFileSync } = await import('node:fs');
      const src = readFileSync(new URL('../../../vendor/holospot/0.1.0/dist/holo.js', import.meta.url), 'utf8');
      const { HOLOSPOT_APPLY_OPTIONS, HOLOSPOT_CARD_OPTIONS } = await import('../../../src/core/validators/LibraryRulesValidator.js');
      for (const name of new Set([...HOLOSPOT_APPLY_OPTIONS, ...HOLOSPOT_CARD_OPTIONS])) {
        expect(src, name).toMatch(new RegExp(`\\b${name}\\b`));
      }
      expect(HOLOSPOT_CARD_OPTIONS).not.toContain('sizeMm');
    });
  });
});
