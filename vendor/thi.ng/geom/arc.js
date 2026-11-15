import { isNumber } from "@thi.ng/checks/is-number";
import { fromEndPoints } from "@thi.ng/geom-arc/from-endpoints";
import { Arc } from "./api/arc.js";
import { absDiff } from "@thi.ng/math/abs";
import { PI } from "@thi.ng/math/api";
const arc = (center, radii, axis, start, end, xl = absDiff(start, end) > PI, clockwise = end > start, attribs) => new Arc(
  center,
  isNumber(radii) ? [radii, radii] : radii,
  axis,
  start,
  end,
  xl,
  clockwise,
  attribs
);
const arcFrom2Points = (a, b, radii, axis = 0, xl = false, cw = false, attribs) => {
  const res = fromEndPoints(a, b, radii, axis, xl, cw);
  return res ? new Arc(
    res.center,
    res.r,
    res.axis,
    res.start,
    res.end,
    res.xl,
    res.cw,
    attribs
  ) : void 0;
};
export {
  arc,
  arcFrom2Points
};
