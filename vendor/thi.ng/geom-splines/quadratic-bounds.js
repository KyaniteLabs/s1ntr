import { clamp01, inRange } from "@thi.ng/math/interval";
import { max } from "@thi.ng/vectors/max";
import { min } from "@thi.ng/vectors/min";
const __solveQuadratic = (a, b, c) => {
  const t = clamp01((a - b) / (a - 2 * b + c));
  const s = 1 - t;
  return s * s * a + 2 * s * t * b + t * t * c;
};
const __inBounds = (p, min2, max2) => {
  for (let i = p.length; i-- > 0; ) {
    if (!inRange(p[i], min2[i], max2[i])) return false;
  }
  return true;
};
const quadraticBounds = (a, b, c) => {
  const mi = min([], a, c);
  const ma = max([], a, c);
  if (!__inBounds(b, mi, ma)) {
    const q = [];
    for (let i = a.length; i-- > 0; ) {
      q[i] = __solveQuadratic(a[i], b[i], c[i]);
    }
    min(null, mi, q);
    max(null, ma, q);
  }
  return [mi, ma];
};
export {
  quadraticBounds
};
