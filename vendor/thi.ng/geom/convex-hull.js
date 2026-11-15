import { defmulti } from "@thi.ng/defmulti/defmulti";
import { grahamScan2 } from "@thi.ng/geom-hull/graham-scan";
import { Polygon } from "./api/polygon.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { vertices } from "./vertices.js";
const convexHull = defmulti(
  __dispatch,
  {
    arc: "group",
    circle: "tri",
    cubic: "group",
    ellipse: "tri",
    line: "tri",
    path: "group",
    poly: "points",
    polyline: "points",
    quad: "points",
    quadratic: "group",
    rect: "tri"
  },
  {
    complexpoly: ($) => convexHull($.boundary),
    group: ($) => new Polygon(grahamScan2(vertices($)), __copyAttribs($.attribs)),
    points: ($) => new Polygon(grahamScan2($.points), __copyAttribs($.attribs)),
    tri: ($) => new Polygon(vertices($), __copyAttribs($.attribs))
  }
);
export {
  convexHull
};
