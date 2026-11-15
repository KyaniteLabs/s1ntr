import { comp } from "@thi.ng/transducers/comp";
import { mapcatIndexed } from "@thi.ng/transducers/mapcat-indexed";
import { partition } from "@thi.ng/transducers/partition";
import { push } from "@thi.ng/transducers/push";
import { transduce } from "@thi.ng/transducers/transduce";
function subdivide(points, kernels, closed = false) {
  for (const { fn, pre, size } of kernels) {
    const nump = points.length;
    points = transduce(
      comp(
        partition(size, 1),
        mapcatIndexed((i, pts) => fn(pts, i, nump, closed))
      ),
      push(),
      pre ? pre(points, closed) : points
    );
  }
  return points;
}
export {
  subdivide
};
