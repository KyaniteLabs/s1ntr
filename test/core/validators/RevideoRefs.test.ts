import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RevideoValidator } from '../../../src/core/validators/RevideoValidator.js';
import { REVIDEO_RULES } from '../../../src/generators/revideo/revideoRules.js';

const FIXTURES = join(__dirname, '../../fixtures/revideo-render-failed');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const scene = (body: string) => `import { makeScene2D, Circle, Rect, Txt } from '@revideo/2d';
import { createRef, createRefArray, all, waitFor } from '@revideo/core';
export default makeScene2D('S', function* (view) {
${body}
  yield* waitFor(1);
});`;

describe('Revideo ref gate', () => {
  it.each(readdirSync(FIXTURES))('rejects %s, an LFM3 scene that passed validation and failed to render', (name) => {
    const result = RevideoValidator.validate(fixture(name));
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(' ref'))).toBe(true);
  });

  it('names each cause in the scene that died on undefined.position', () => {
    expect(RevideoValidator.validate(fixture('1160474fa0713882.tsx')).errors).toEqual([
      'Revideo createRef() takes no arguments (bgRef = createRef(...)): declare it empty and bind a node with <Rect ref={bgRef} ... />',
      'Revideo .add(bgRef) adds the ref, not a node: add the element with ref={bgRef} on it, like view.add(<Rect ref={bgRef} ... />)',
      'Revideo createRef() takes no arguments (handRef = createRef(...)): declare it empty and bind a node with <Rect ref={handRef} ... />',
      'Revideo .add(handRef) adds the ref, not a node: add the element with ref={handRef} on it, like view.add(<Rect ref={handRef} ... />)',
      'Revideo ref handRef is never bound to a node, so handRef() is undefined at render: add ref={handRef} to the JSX element it should hold',
      'Revideo createRef() takes no arguments (sparkRef = createRef(...)): declare it empty and bind a node with <Rect ref={sparkRef} ... />',
      'Revideo .add(sparkRef) adds the ref, not a node: add the element with ref={sparkRef} on it, like view.add(<Rect ref={sparkRef} ... />)',
      'Revideo ref sparkRef is never bound to a node, so sparkRef() is undefined at render: add ref={sparkRef} to the JSX element it should hold',
    ]);
  });

  it('names an unbound ref and a ref read without the call', () => {
    expect(RevideoValidator.validate(fixture('5a83b95a575dad72.tsx')).errors).toEqual([
      'Revideo handTip is a ref, so handTip.position is undefined: call it to get the node, handTip().position',
      'Revideo ref handTip is never bound to a node, so handTip() is undefined at render: add ref={handTip} to the JSX element it should hold',
      'Revideo label is a ref, so label.opacity is undefined: call it to get the node, label().opacity',
    ]);
  });

  it('rejects a scene that does not parse', () => {
    const result = RevideoValidator.validate(scene('  view.add(<Rect width={10} />;'));
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.startsWith('Revideo scene has a syntax error'))).toBe(true);
  });

  it('rejects a scene wrapped in a markdown fence', () => {
    const fenced = '```tsx\n' + scene(`  const a = createRef<Circle>();\n  yield* a().scale(2, 1);`) + '\n```';
    expect(RevideoValidator.validate(fenced).errors).toContain('Revideo scene is wrapped in a markdown fence: return the TSX source only, with no ``` lines');
  });

  it.each([
    ['used only in a type', `  const a = createRef<Circle>();
  type Held = typeof a;
  view.add(<Circle size={10} />);
  yield* a().scale(2, 1);`],
    ['only logged', `  const a = createRef<Circle>();
  console.log(a);
  view.add(<Circle size={10} />);
  yield* a().scale(2, 1);`],
    ['only used as a fill', `  const a = createRef<Circle>();
  view.add(<Circle size={10} fill={a} />);
  yield* a().scale(2, 1);`],
    ['bound only in an inner scope that redeclares the name', `  const a = createRef<Circle>();
  { const a = createRef<Circle>(); view.add(<Circle ref={a} size={10} />); }
  yield* a().scale(2, 1);`],
  ])('rejects a ref %s', (_name, body) => {
    expect(RevideoValidator.validate(scene(body)).errors).toContain(
      'Revideo ref a is never bound to a node, so a() is undefined at render: add ref={a} to the JSX element it should hold',
    );
  });

  it.each([
    ['a JSX-bound ref called before use', `  const ring = createRef<Circle>();
  view.add(<Rect width={1920} height={1080} fill={'#000'}><Circle ref={ring} size={200} fill={'#f0f'} /></Rect>);
  yield* all(ring().scale(1.4, 2), ring().rotation(90, 2));`],
    ['a ref bound by calling it with a node', `  const box = createRef<Rect>();
  box(new Rect({ width: 100, height: 100 }));
  view.add(box());
  yield* box().opacity(1, 0.5);`],
    ['a ref bound through a ref: property', `  const label = createRef<Txt>();
  view.add(new Txt({ ref: label, text: 'hi' }));
  yield* label()?.opacity(1, 0.5);`],
    ['a ref handed to a helper that binds it', `  const ring = createRef<Circle>();
  const mount = (target: typeof ring) => view.add(<Circle ref={target} size={200} />);
  mount(ring);
  yield* ring().scale(2, 1);`],
    ['a callback parameter that reuses a ref name', `  const label = createRef<Txt>();
  view.add(<Txt ref={label} text={'a'} />);
  const words = [{ text: 'b' }].map((label) => label.text);
  yield* label().text(words[0], 0.5);`],
    ['casts and non-null assertions', `  const a = createRef<Circle>();
  view.add(<Circle ref={a as any} size={10} />);
  yield* a()!.scale(2, 1);
  yield* (a as typeof a)().opacity(1, 0.5);`],
    ['refs bound in a loop through createRefArray and an array of refs', `  const dots = createRefArray<Circle>();
  const rings = [createRef<Circle>(), createRef<Circle>()];
  const first = createRef<Rect>();
  const all3 = [first];
  all3.forEach((r) => view.add(<Rect ref={r} />));
  view.add(<>{[1, 2].map((i) => <Circle ref={dots} size={i * 10} />)}</>);
  yield* first().opacity(1, 0.5);`],
    ['a ref declared but never used', `  const unused = createRef<Rect>();
  view.add(<Rect width={1920} height={1080} fill={'#000'} />);`],
  ])('accepts %s', (_name, body) => {
    const result = RevideoValidator.validate(scene(body));
    expect(result.errors).toEqual([]);
  });

  it('keeps the ref contract in the prompt rules', () => {
    expect(REVIDEO_RULES).toContain('<Circle ref={ring} ... />');
    expect(REVIDEO_RULES).toContain('Never ring.scale(...)');
  });
});
