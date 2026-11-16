import { makeScene2D, Txt, Rect, Circle } from '@revideo/2d';
import { createRef, all, waitFor } from '@revideo/core';

export default makeScene2D('MelancholyClock', function* (view) {
  // Create three refs for background, hand, and surprise spark
  const bgRef = createRef<Rect>(() => new Rect(0, 0, 800, 600, '#111'));
  const handRef = createRef<Circle>(() => new Circle(0, 0, 12));
  const sparkRef = createRef<Rect>(() => new Rect(0, 0, 40, 40, '#ff6b6b'));

  // Add each node to the view
  view.add(bgRef);
  view.add(handRef);
  view.add(sparkRef);

  // Step 1: Sweep the clock hand to the right
  yield* handRef().position(0, 250).to({ x: 800, y: 250 }, { duration: 1000 });
  // Step 2: Continue sweeping to the left
  yield* handRef().position(800, 250).to({ x: 0, y: 250 }, { duration: 1000 });

  // Surprise element: a flashing red spark appears and floats upward
  yield* sparkRef().position(0, 450).to({ x: 35, y: 30 }, { duration: 1500 });

  // Bring the hand back to the start
  yield* handRef().position(0, 250).to({ x: 800, y: 250 }, { duration: 1000 });

  // Define tweens for the overall animation (~5 seconds)
  const handTweens = [
    { type: 'position', node: 'handRef', target: { x: 800, y: 250 }, duration: 1000 },
    { type: 'position', node: 'handRef', target: { x: 0, y: 250 }, duration: 1000 },
  ];
  const sparkTweens = [
    { type: 'position', node: 'sparkRef', target: { x: 35, y: 30 }, duration: 1500 },
  ];

  // Run all tweens together
  yield* all([...handTweens, ...sparkTweens]);

  // Wait for the animation to finish and settle
  yield* waitFor(5000);
});