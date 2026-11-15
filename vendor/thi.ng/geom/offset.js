import { defmulti } from "@thi.ng/defmulti/defmulti";
import { offsetConvex } from "@thi.ng/geom-poly-utils/offset-convex";
import { add2 } from "@thi.ng/vectors/add";
import { normalCW } from "@thi.ng/vectors/normal";
import { set2 } from "@thi.ng/vectors/set";
import { sub2 } from "@thi.ng/vectors/sub";
import { aabbWithCentroidAndMargin } from "./aabb.js";
import { Circle } from "./api/circle.js";
import { Polygon } from "./api/polygon.js";
import { Quad } from "./api/quad.js";
import { centroid } from "./centroid.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { rectWithCentroidAndMargin } from "./rect.js";
import { ComplexPolygon } from "./api/complex-polygon.js";
const offset = defmulti(
  __dispatch,
  {},
  {
    aabb: ($, n) => aabbWithCentroidAndMargin(
      centroid($),
      $.size,
      n,
      __copyAttribs($.attribs)
    ),
    circle: ($, n) => new Circle(set2([], $.pos), Math.max($.r + n, 0)),
    complexpoly: ({ boundary, children, attribs }, n) => new ComplexPolygon(
      offset(boundary, n),
      children.map(
        (x) => offset(x, n),
        __copyAttribs(attribs)
      )
    ),
    line: ({ points: [a, b], attribs }, n) => {
      const norm = normalCW([], a, b, n);
      return new Quad(
        [
          add2([], a, norm),
          add2([], b, norm),
          sub2([], b, norm),
          sub2([], a, norm)
        ],
        __copyAttribs(attribs)
      );
    },
    poly: ({ points, attribs }, n) => new Polygon(offsetConvex(points, n), __copyAttribs(attribs)),
    rect: ($, n) => rectWithCentroidAndMargin(
      centroid($),
      $.size,
      n,
      __copyAttribs($.attribs)
    )
  }
);
export {
  offset
};
