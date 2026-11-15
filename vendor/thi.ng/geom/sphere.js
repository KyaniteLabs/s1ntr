import { dist3 } from "@thi.ng/vectors/dist";
import { mixN3 } from "@thi.ng/vectors/mixn";
import { Sphere } from "./api/sphere.js";
import { __argsVN } from "./internal/args.js";
function sphere(...args) {
  return new Sphere(...__argsVN(args));
}
const sphereFrom2Points = (a, b, attribs) => new Sphere(mixN3([], a, b, 0.5), dist3(a, b) / 2, attribs);
export {
  sphere,
  sphereFrom2Points
};
