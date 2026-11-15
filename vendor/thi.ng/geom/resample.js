import { defmulti } from "@thi.ng/defmulti/defmulti";
import { resample as _resample } from "@thi.ng/geom-resample/resample";
import { asPolygon } from "./as-polygon.js";
import { asPolyline } from "./as-polyline.js";
import { __dispatch } from "./internal/dispatch.js";
const resample = defmulti(
  __dispatch,
  {
    arc: "$aspolyline",
    circle: "$aspoly",
    complexpoly: "group",
    cubic: "$aspolyline",
    cubic3: "$aspolyline",
    ellipse: "$aspoly",
    line: "$aspolyline",
    line3: "$aspolyline",
    poly3: "poly",
    polyline3: "polyline",
    quad: "$aspoly",
    quad3: "$aspoly",
    quadratic: "$aspolyline",
    quadratic3: "$aspolyline",
    rect: "$aspoly",
    tri: "$aspoly",
    tri3: "$aspoly"
  },
  {
    $aspoly: ($, opts) => asPolygon($, opts)[0],
    $aspolyline: ($, opts) => asPolyline($, opts)[0],
    group: ($, opts) => $.copyTransformed((child) => resample(child, opts)),
    poly: ($, opts) => $.copyTransformed(
      (points) => _resample(points, opts, true, true)
    ),
    polyline: ($, opts) => $.copyTransformed(
      (points) => _resample(points, opts, false, true)
    )
  }
);
export {
  resample
};
