import { centroid } from "@thi.ng/geom-poly-utils/centroid";
import { SQRT2_2, SQRT3 } from "@thi.ng/math/api";
import { add2 } from "@thi.ng/vectors/add";
import { ZERO2 } from "@thi.ng/vectors/api";
import { dist2 } from "@thi.ng/vectors/dist";
import { maddN2 } from "@thi.ng/vectors/maddn";
import { max2 } from "@thi.ng/vectors/max";
import { min2 } from "@thi.ng/vectors/min";
import { sub2 } from "@thi.ng/vectors/sub";
import { subN2 } from "@thi.ng/vectors/subn";
import { Rect } from "./api/rect.js";
import { __argAttribs, __argsVV, __asVec } from "./internal/args.js";
function rect(...args) {
  return new Rect(...__argsVV(args));
}
const rectFromMinMax = (min, max, attribs) => new Rect(min, sub2([], max, min), attribs);
const rectFromMinMaxWithMargin = (min, max, margin, attribs) => rectFromMinMax(min, max, attribs).offset(margin);
const rectWithCentroid = (centroid2, size, attribs) => {
  size = __asVec(size);
  return new Rect(maddN2([], size, -0.5, centroid2), size, attribs);
};
const rectWithCentroidAndMargin = (centroid2, size, margin, attribs) => rectWithCentroid(centroid2, size, attribs).offset(margin);
const intersectionRect = (a, b) => {
  const p = max2([], a.pos, b.pos);
  const q = min2(null, add2([], a.pos, a.size), add2([], b.pos, b.size));
  const size = max2(null, sub2(null, q, p), ZERO2);
  return size[0] > 0 && size[1] > 0 ? new Rect(p, size) : void 0;
};
function inscribedSquare(...args) {
  let pos, r;
  const attribs = __argAttribs(args);
  if (args.length === 1) {
    const c = args[0];
    pos = c.pos;
    r = c.r;
  } else {
    [pos, r] = args;
  }
  r *= SQRT2_2;
  return rect(subN2([], pos, r), r * 2, attribs);
}
function inscribedSquareHex(...args) {
  let pos, l;
  const attribs = __argAttribs(args);
  if (args.length === 1) {
    const pts = args[0].points;
    pos = centroid(pts);
    l = dist2(pts[0], pts[1]);
  } else {
    [pos, l] = args;
  }
  l *= 3 - SQRT3;
  return rect(subN2([], pos, l / 2), l, attribs);
}
export {
  inscribedSquare,
  inscribedSquareHex,
  intersectionRect,
  rect,
  rectFromMinMax,
  rectFromMinMaxWithMargin,
  rectWithCentroid,
  rectWithCentroidAndMargin
};
