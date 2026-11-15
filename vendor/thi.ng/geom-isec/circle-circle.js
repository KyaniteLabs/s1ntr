import { eqDelta } from "@thi.ng/math/eqdelta";
import { add2 } from "@thi.ng/vectors/add";
import { distSq } from "@thi.ng/vectors/distsq";
import { maddN2 } from "@thi.ng/vectors/maddn";
import { mag2 } from "@thi.ng/vectors/mag";
import { mulN2 } from "@thi.ng/vectors/muln";
import { perpendicularCCW } from "@thi.ng/vectors/perpendicular";
import { sub2 } from "@thi.ng/vectors/sub";
import { IntersectionType, NONE } from "./api.js";
const intersectCircleCircle = (a, b, ar, br) => {
  const delta = sub2([], b, a);
  const d = mag2(delta);
  if (eqDelta(d, 0)) {
    return { type: IntersectionType.COINCIDENT };
  }
  if (d <= ar + br && d >= Math.abs(ar - br)) {
    ar *= ar;
    const alpha = (ar - br * br + d * d) / (2 * d);
    const h = Math.sqrt(ar - alpha * alpha);
    const p = maddN2([], delta, alpha / d, a);
    const t = mulN2(null, perpendicularCCW(null, delta), h / d);
    return {
      type: IntersectionType.INTERSECT,
      isec: [add2([], p, t), sub2(null, p, t)]
    };
  }
  return NONE;
};
const testCircleCircle = (a, b, ar, br) => distSq(a, b) <= (ar + br) ** 2;
export {
  intersectCircleCircle,
  testCircleCircle
};
