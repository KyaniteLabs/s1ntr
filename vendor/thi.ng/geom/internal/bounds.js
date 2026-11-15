import { add } from "@thi.ng/vectors/add";
import { max } from "@thi.ng/vectors/max";
import { min } from "@thi.ng/vectors/min";
import { sub } from "@thi.ng/vectors/sub";
const __collBounds = (shapes, bounds) => {
  let n = shapes.length - 1;
  if (n < 0) return;
  let b = bounds(shapes[n]);
  if (!b) return;
  let { pos, size } = b;
  for (; n-- > 0; ) {
    b = bounds(shapes[n]);
    if (!b) continue;
    [pos, size] = __unionBounds(pos, size, b.pos, b.size);
  }
  return [pos, size];
};
const __unionBounds = (apos, asize, bpos, bsize) => {
  const p = add([], apos, asize);
  const q = add([], bpos, bsize);
  const pos = min([], apos, bpos);
  return [pos, sub(null, max(null, p, q), pos)];
};
export {
  __collBounds,
  __unionBounds
};
