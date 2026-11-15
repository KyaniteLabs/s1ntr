import { defmulti } from "@thi.ng/defmulti/defmulti";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { asPolygon } from "./as-polygon.js";
import { asPolyline } from "./as-polyline.js";
import { __dispatch } from "./internal/dispatch.js";
import { __edges } from "./internal/edges.js";
import { vertices } from "./vertices.js";
const edges = defmulti(
  __dispatch,
  {
    cubic: "arc",
    ellipse: "circle",
    line: "polyline",
    quad: "poly",
    quadratic: "arc",
    tri: "poly"
  },
  {
    aabb: ($) => {
      const [a, b, c, d, e, f, g, h] = vertices($);
      return [
        [a, b],
        [b, c],
        [c, d],
        [d, a],
        // bottom
        [e, f],
        [f, g],
        [g, h],
        [h, e],
        // top
        [a, e],
        [b, f],
        // left
        [c, g],
        [d, h]
        // right
      ];
    },
    arc: ($, opts) => __edges(asPolyline($, opts)[0].points),
    bpatch: ($) => $.edges(),
    circle: ($, opts) => __edges(asPolygon($, opts)[0].points, true),
    complexpoly: ($) => mapcat(
      (poly) => __edges(poly.points, true),
      [$.boundary, ...$.children]
    ),
    group: ($, opts) => mapcat((c) => edges(c, opts), $.children),
    path: ($, opts) => mapcat((poly) => __edges(poly.points), asPolyline($, opts)),
    poly: ($) => __edges($.points, true),
    polyline: ($) => __edges($.points),
    rect: ($) => __edges(vertices($), true)
  }
);
export {
  edges
};
