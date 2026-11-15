import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { perimeter } from "@thi.ng/geom-poly-utils/perimeter";
import { PI, TAU } from "@thi.ng/math/api";
import { dist } from "@thi.ng/vectors/dist";
import { asPolygon } from "./as-polygon.js";
import { asPolyline } from "./as-polyline.js";
import { __dispatch } from "./internal/dispatch.js";
const arcLength = defmulti(
  __dispatch,
  {
    arc: "$aspolyline",
    cubic: "$aspolyline",
    cubic3: "$aspolyline",
    group3: "group",
    line3: "line",
    path3: "path",
    poly3: "poly",
    polyline3: "polyline",
    quad: "poly",
    quad3: "poly",
    quadratic: "$aspolyline",
    quadratic3: "$aspolyline",
    tri: "poly",
    tri3: "tri"
  },
  {
    [DEFAULT]: () => 0,
    $aspoly: ($) => asPolygon($).reduce((acc, p) => acc + arcLength(p), 0),
    $aspolyline: ($) => asPolyline($).reduce((acc, p) => acc + arcLength(p), 0),
    circle: ($) => TAU * $.r,
    complexpoly: ($) => [$.boundary, ...$.children].reduce(
      (acc, c) => acc + arcLength(c),
      0
    ),
    ellipse: ({ r: [a, b] }) => (
      // Ramanujan approximation
      // https://www.mathsisfun.com/geometry/ellipse-perimeter.html
      PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (3 * b + a)))
    ),
    group: ({ children }) => children.reduce((sum, $) => sum + arcLength($), 0),
    line: ({ points }) => dist(points[0], points[1]),
    path: ($) => {
      return ($.closed ? asPolygon($) : asPolyline($)).reduce(
        (acc, p) => acc + arcLength(p),
        0
      );
    },
    poly: ({ points }) => perimeter(points, points.length, true),
    polyline: ({ points }) => perimeter(points),
    rect: ({ size: [w, h] }) => 2 * (w + h),
    tri: ({ points }) => dist(points[0], points[1]) + dist(points[1], points[2]) + dist(points[2], points[0])
  }
);
export {
  arcLength
};
