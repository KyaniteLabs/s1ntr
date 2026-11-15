import { defmulti } from "@thi.ng/defmulti/defmulti";
import { Path } from "./api/path.js";
import { Points } from "./api/points.js";
import { Polygon } from "./api/polygon.js";
import { Polyline } from "./api/polyline.js";
import { asPolygon } from "./as-polygon.js";
import { asPolyline } from "./as-polyline.js";
import { __dispatch } from "./internal/dispatch.js";
import { __ensureNoArc } from "./internal/error.js";
import {
  __segmentTransformer,
  __transformedPointsWith
} from "./internal/transform.js";
const transformVertices = defmulti(
  __dispatch,
  {
    arc: "$aspolyline",
    circle: "$aspoly",
    complexpoly: "group",
    ellipse: "$aspoly",
    group3: "group",
    bpatch: "points",
    cubic: "points",
    cubic3: "points",
    line: "points",
    line3: "points",
    path3: "path",
    points3: "points",
    poly: "points",
    poly3: "points",
    polyline: "points",
    polyline3: "points",
    quad: "points",
    quad3: "points",
    quadratic: "points",
    quadratic3: "points",
    rect: "$aspoly",
    tri: "points",
    tri3: "points"
  },
  {
    $aspoly: ($, fn) => transformVertices(asPolygon($)[0], fn),
    $aspolyline: ($, fn) => transformVertices(asPolyline($)[0], fn),
    extra: ($) => $,
    group: ($, fn) => $.copyTransformed((x) => transformVertices(x, fn)),
    path: ($, fn) => $.copyTransformed(
      __segmentTransformer((geo) => {
        __ensureNoArc(geo);
        return transformVertices(geo, fn);
      }, fn)
    ),
    points: ($, fn) => $.copyTransformed((pts) => __transformedPointsWith(pts, fn))
  }
);
export {
  transformVertices
};
