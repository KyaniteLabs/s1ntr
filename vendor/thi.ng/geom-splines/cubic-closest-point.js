import { minError } from "@thi.ng/math/min-error";
import { distSq } from "@thi.ng/vectors/distsq";
import { mixCubic } from "@thi.ng/vectors/mix-cubic";
const closestPointCubic = (p, a, b, c, d, out = [], res, iter, eps) => {
  const fn = (t) => mixCubic(out, a, b, c, d, t);
  return fn(minError(fn, distSq, p, res, iter, 0, 1, eps));
};
export {
  closestPointCubic
};
