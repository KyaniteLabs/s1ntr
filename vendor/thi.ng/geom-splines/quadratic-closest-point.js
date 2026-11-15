import { minError } from "@thi.ng/math/min-error";
import { distSq } from "@thi.ng/vectors/distsq";
import { mixQuadratic } from "@thi.ng/vectors/mix-quadratic";
const closestPointQuadratic = (p, a, b, c, out = [], res, iter, eps) => {
  const fn = (t) => mixQuadratic(out, a, b, c, t);
  return fn(minError(fn, distSq, p, res, iter, 0, 1, eps));
};
export {
  closestPointQuadratic
};
