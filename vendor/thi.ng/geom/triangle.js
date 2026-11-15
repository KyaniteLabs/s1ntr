import { equilateralTriangle2 } from "@thi.ng/geom-poly-utils/equilateral";
import { Triangle } from "./api/triangle.js";
import { __pclike } from "./internal/pclike.js";
function triangle(...args) {
  return __pclike(Triangle, args);
}
const equilateralTriangle = (a, b, attribs) => new Triangle(equilateralTriangle2(a, b), attribs);
export {
  equilateralTriangle,
  triangle
};
