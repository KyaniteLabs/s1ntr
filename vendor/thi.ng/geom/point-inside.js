import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import {
  pointInAABB,
  pointInCircle,
  pointInPolygon2,
  pointInRect,
  pointInSegment,
  pointInSegments,
  pointInTriangle2
} from "@thi.ng/geom-isec/point";
import { isInArray } from "@thi.ng/vectors/eqdelta";
import { __dispatch } from "./internal/dispatch.js";
const pointInside = defmulti(
  __dispatch,
  {
    group3: "group",
    points3: "points",
    quad: "poly",
    sphere: "circle"
  },
  {
    [DEFAULT]: () => false,
    aabb: ($, p) => pointInAABB(p, $.pos, $.size),
    circle: ($, p) => pointInCircle(p, $.pos, $.r),
    complexpoly: ($, p) => pointInPolygon2(p, $.boundary.points) ? !$.children.some((child) => pointInPolygon2(p, child.points)) : false,
    group: ($, p) => $.children.some((child) => pointInside(child, p)),
    line: ($, p) => pointInSegment(p, $.points[0], $.points[1]),
    points: ({ points }, p) => isInArray(p, points),
    poly: ($, p) => pointInPolygon2(p, $.points) > 0,
    polyline: ($, p) => pointInSegments(p, $.points, false),
    rect: ($, p) => pointInRect(p, $.pos, $.size),
    tri: (tri, p) => pointInTriangle2(p, ...tri.points)
  }
);
export {
  pointInside
};
