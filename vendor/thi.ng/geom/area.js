import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { polyArea2 } from "@thi.ng/geom-poly-utils/area";
import { PI } from "@thi.ng/math/api";
import { signedArea2 } from "@thi.ng/vectors/signed-area";
import { asPolygon } from "./as-polygon.js";
import { __dispatch } from "./internal/dispatch.js";
const area = defmulti(
  __dispatch,
  { group3: "group", quad: "poly" },
  {
    [DEFAULT]: () => 0,
    aabb: ({ size: [w, h, d] }) => 2 * (w * h + w * d + h * d),
    arc: (
      // http://cut-the-knot.org/Generalization/Cavalieri2.shtml
      ($) => 0.5 * Math.abs($.start - $.end) * $.r[0] * $.r[1]
    ),
    circle: ($) => PI * $.r ** 2,
    complexpoly: ($, signed) => area($.boundary, signed) - $.children.reduce((acc, c) => acc + area(c, signed), 0),
    ellipse: ($) => PI * $.r[0] * $.r[1],
    group: ({ children }) => children.reduce((sum, $) => sum + area($, false), 0),
    path: ($, signed) => {
      return $.closed ? asPolygon($).reduce((acc, p) => acc + area(p, signed), 0) : 0;
    },
    plane: () => Infinity,
    poly: ($, signed) => {
      const area2 = polyArea2($.points);
      return signed ? area2 : Math.abs(area2);
    },
    rect: ($) => $.size[0] * $.size[1],
    sphere: ($) => 4 * PI * $.r ** 2,
    tri: ($, signed) => {
      const area2 = 0.5 * signedArea2(...$.points);
      return signed ? area2 : Math.abs(area2);
    }
  }
);
export {
  area
};
