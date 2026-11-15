import { add2, add3 } from "@thi.ng/vectors/add";
import { direction2, direction3 } from "@thi.ng/vectors/direction";
const closestPointCircle = (p, c, r, out = []) => add2(out, c, direction2(out, c, p, r));
const closestPointSphere = (p, c, r, out = []) => add3(out, c, direction3(out, c, p, r));
export {
  closestPointCircle,
  closestPointSphere
};
