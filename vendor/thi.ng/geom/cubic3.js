import { cubicFromLine as $line } from "@thi.ng/geom-splines/cubic-line";
import { cubicFromQuadratic as $quad } from "@thi.ng/geom-splines/cubic-quadratic";
import { Cubic3 } from "./api/cubic3.js";
import { __pclike } from "./internal/pclike.js";
function cubic3(...args) {
  return __pclike(Cubic3, args);
}
const cubicFromLine3 = (a, b, attribs) => new Cubic3($line(a, b), attribs);
const cubicFromQuadratic3 = (a, b, c, attribs) => new Cubic3($quad(a, b, c), attribs);
export {
  cubic3,
  cubicFromLine3,
  cubicFromQuadratic3
};
