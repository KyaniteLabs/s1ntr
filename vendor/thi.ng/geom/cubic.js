import { cubicFromArc as $arc } from "@thi.ng/geom-splines/cubic-arc";
import { cubicFromLine as $line } from "@thi.ng/geom-splines/cubic-line";
import { cubicFromQuadratic as $quad } from "@thi.ng/geom-splines/cubic-quadratic";
import { Cubic } from "./api/cubic.js";
import { __copyAttribs } from "./internal/copy.js";
import { __pclike } from "./internal/pclike.js";
function cubic(...args) {
  return __pclike(Cubic, args);
}
const cubicFromArc = (arc) => $arc(arc.pos, arc.r, arc.axis, arc.start, arc.end).map(
  (c) => new Cubic(c, __copyAttribs(arc.attribs))
);
const cubicFromLine = (a, b, attribs) => new Cubic($line(a, b), attribs);
const cubicFromQuadratic = (a, b, c, attribs) => new Cubic($quad(a, b, c), attribs);
export {
  cubic,
  cubicFromArc,
  cubicFromLine,
  cubicFromQuadratic
};
