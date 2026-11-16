import { makeScene2D, Txt, Rect, Circle } from '@revideo/2d';
import { createRef, all, waitFor } from '@revideo/core';

export default makeScene2D('MelancholyClock', function* (view) {
  // Refs for the nodes we will add
  const clockFace = createRef<Rect>();
  const handTip   = createRef<Circle>();
  const label     = createRef<Txt>();

  // Node 1: dark clock face background
  view.add(
    <Rect width={'100%'} height={'100%'} fill={'#111'}>
      <Txt ref={label} text={'Time'} fill={'#fff'} fontSize={72} />
    </Rect>
  );

  // Node 2: moving clock hand (a circle)
  view.add(
    <Circle cx={'50%'} cy={'50%'} r={'20%'} fill={'#222'} stroke={'#f0a0'} />
  );

  // Node 3: surprising sparkle at the centre
  view.add(
    <Circle cx={'50%'} cy={'50%'} r={'10%'} fill={'#0ff'} opacity={'1'} />
  );

  // 1️⃣ Fade the label out (melancholy mood)
  yield* label.opacity(1, 0.5);
  yield* waitFor(1);

  // 2️⃣ Sweep the hand tip across the stage (four steps ≈ 4 s)
  yield* handTip.position(0, 0).to({ x: '80%', y: '0%' });
  yield* waitFor(1);
  yield* handTip.position('80%', '0%').to({ x: '80%', y: '80%' });
  yield* waitFor(1);
  yield* handTip.position('80%', '80%').to({ x: '0%', y: '80%' });
  yield* waitFor(1);
  yield* handTip.position('0%', '80%').to({ x: '0%', y: '0%' });
  yield* waitFor(1);

  // 3️⃣ Combine all hand‑tip tween steps into one `all()` for brevity
  yield* all([
    handTip.position(0, 0).to({ x: '80%', y: '0%' }),
    handTip.position('80%', '0%').to({ x: '80%', y: '80%' }),
    handTip.position('80%', '80%').to({ x: '0%', y: '80%' }),
    handTip.position('0%', '80%').to({ x: '0%', y: '0%' })
  ]);
  yield* waitFor(5);
});