import { defmulti } from "@thi.ng/defmulti/defmulti";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { copy, copyVectors } from "@thi.ng/vectors/copy";
import { Polygon } from "./api/polygon.js";
import { Polygon3 } from "./api/polygon3.js";
import { __copyAttribsNoSamples as __attribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { vertices } from "./vertices.js";
const asPolygon = defmulti(
  __dispatch,
  {
    circle: "points",
    complexpoly: "group",
    ellipse: "points",
    line: "points",
    line3: "points3",
    poly: "points",
    poly3: "points3",
    polyline: "points",
    polyline3: "points3",
    quad: "points",
    quad3: "points3",
    rect: "points",
    tri: "points",
    tri3: "points3"
  },
  {
    aabb: ($) => {
      const [a, b, c, d, e, f, g, h] = vertices($);
      return [
        [f, g, h, e],
        // n
        [a, d, c, b],
        // s
        [c, d, h, g],
        // e
        [a, b, f, e],
        // w
        [b, c, g, f],
        // f
        [d, a, e, h]
        // b
      ].map((face) => new Polygon3(copyVectors(face), __attribs($)));
    },
    arc: ($, opts) => {
      const pts = [copy($.pos), ...vertices($, opts)];
      return [new Polygon(pts, __attribs($))];
    },
    group: ($, opts) => [
      ...mapcat((child) => asPolygon(child, opts), $)
    ],
    path: ($, opts) => __path(Polygon, $, opts),
    path3: ($, opts) => __path(Polygon3, $, opts),
    points: ($, opts) => [
      new Polygon(vertices($, opts), __attribs($))
    ],
    points3: ($, opts) => [
      new Polygon3(vertices($, opts), __attribs($))
    ]
  }
);
const __path = (ctor, $, opts) => {
  const tmp = $.empty();
  tmp.attribs = $.attribs;
  return [$.segments, ...$.subPaths].map((segments) => {
    tmp.segments = segments;
    return new ctor(vertices(tmp, opts), __attribs($));
  });
};
export {
  asPolygon
};
