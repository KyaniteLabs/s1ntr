import { quadraticFromLine as _line } from "@thi.ng/geom-splines/quadratic-line";
import { Quadratic } from "./api/quadratic.js";
import { __pclike } from "./internal/pclike.js";
function quadratic(...args) {
  return __pclike(Quadratic, args);
}
const quadraticFromLine = (a, b, attribs) => new Quadratic(_line(a, b), attribs);
export {
  quadratic,
  quadraticFromLine
};
