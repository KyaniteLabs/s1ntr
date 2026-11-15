import { SYSTEM } from "@thi.ng/random/system";
import { randMinMax } from "@thi.ng/vectors/rand-minmax";
import { bounds } from "./bounds.js";
import { pointInside } from "./point-inside.js";
const scatter = (shape, num, rnd = SYSTEM, out = []) => {
  const b = bounds(shape);
  if (!b) return;
  const mi = b.pos;
  const mx = b.max();
  for (; num-- > 0; ) {
    while (true) {
      const p = randMinMax([], mi, mx, rnd);
      if (pointInside(shape, p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
};
export {
  scatter
};
