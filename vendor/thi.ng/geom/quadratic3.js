import { quadraticFromLine as _line } from "@thi.ng/geom-splines/quadratic-line";
import { Quadratic3 } from "./api/quadratic3.js";
import { __pclike } from "./internal/pclike.js";
function quadratic3(...args) {
  return __pclike(Quadratic3, args);
}
const quadraticFromLine3 = (a, b, attribs) => new Quadratic3(_line(a, b), attribs);
export {
  quadratic3,
  quadraticFromLine3
};
