/**
 * Revideo scene rules, shared by the legacy RevideoGenerator and the governed
 * production path. A leaf module on purpose: the governed path must not load
 * TierBasedGenerator (production authority registry, #1628).
 */
export const REVIDEO_RULES = [
  'Return one Revideo scene source file (TSX) and nothing else: no HTML, no markdown fences, no prose.',
  'Shape: export default makeScene2D("SceneName", function* (view) { view.add(...); yield* ...; });',
  'Import only from @revideo/2d (makeScene2D, Rect, Circle, Txt, Line, Path, Layout, Gradient, ...) and @revideo/core (createRef, createSignal, all, sequence, loop, waitFor, easing helpers, Color, Vector2).',
  'The stage is 1920x1080 with (0,0) at the centre. Fill it: add a full-frame background first.',
  'Refs: const ring = createRef<Circle>(); with no arguments, bind it with <Circle ref={ring} ... /> inside view.add(...), then call it to reach the node: ring().scale(...). Never ring.scale(...), never view.add(ring), never createRef(() => ...).',
  'Animate with yield* on node signals, e.g. yield* all(ring().scale(1.4, 2), ring().rotation(90, 2)); end with yield* waitFor(1). Keep the whole scene between 4 and 20 seconds.',
  'No network, no fetch, no images or video from URLs, no staticFile, no Audio/Video nodes: the render is offline and anything external fails.',
  'Do not use p5.js, createCanvas, setup(), draw(), Remotion, React.FC, @revideo/react, useFrame or useCurrentFrame.',
].join('\n');
