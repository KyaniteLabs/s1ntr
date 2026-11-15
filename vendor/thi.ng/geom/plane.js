import { dot3 } from "@thi.ng/vectors/dot";
import { normalize3 } from "@thi.ng/vectors/normalize";
import { orthoNormal3 } from "@thi.ng/vectors/ortho-normal";
import { set3 } from "@thi.ng/vectors/set";
import { Plane } from "./api/plane.js";
const plane = (normal, w, attribs) => new Plane(normalize3(null, normal), w, attribs);
const planeWithPoint = (normal, p, attribs) => {
  normal = normalize3(null, normal);
  return new Plane(normal, dot3(normal, p), attribs);
};
const planeFromRay = ({ pos, dir, attribs }, $attribs) => new Plane(set3([], dir), dot3(dir, pos), $attribs || attribs);
const planeFrom3Points = (a, b, c, attribs) => planeWithPoint(orthoNormal3([], a, b, c), a, attribs);
export {
  plane,
  planeFrom3Points,
  planeFromRay,
  planeWithPoint
};
