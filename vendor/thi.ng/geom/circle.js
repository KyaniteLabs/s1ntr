import { circumCenter2 } from "@thi.ng/geom-poly-utils/circumcenter";
import { dist2 } from "@thi.ng/vectors/dist";
import { mixN2 } from "@thi.ng/vectors/mixn";
import { Circle } from "./api/circle.js";
import { __argsVN } from "./internal/args.js";
function circle(...args) {
  return new Circle(...__argsVN(args));
}
const circleFrom2Points = (a, b, attribs) => new Circle(mixN2([], a, b, 0.5), dist2(a, b) / 2, attribs);
const circleFrom3Points = (a, b, c, attribs) => {
  const o = circumCenter2(a, b, c);
  return o ? new Circle(o, dist2(a, o), attribs) : void 0;
};
export {
  circle,
  circleFrom2Points,
  circleFrom3Points
};
