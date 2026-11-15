import { defmulti } from "@thi.ng/defmulti/defmulti";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { set } from "@thi.ng/vectors/set";
import { Polyline } from "./api/polyline.js";
import { Polyline3 } from "./api/polyline3.js";
import { __copyAttribsNoSamples as __attribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { vertices } from "./vertices.js";
const asPolyline = defmulti(
  __dispatch,
  {
    arc: "points",
    circle: "poly",
    complexpoly: "group",
    cubic: "points",
    cubic3: "points3",
    ellipse: "poly",
    line: "points",
    line3: "points3",
    polyline: "points",
    polyline3: "points3",
    quad: "poly",
    quad3: "poly3",
    quadratic: "points",
    quadratic3: "points3",
    rect: "poly",
    tri: "poly",
    tri3: "poly3"
  },
  {
    group: ($, opts) => [
      ...mapcat((child) => asPolyline(child, opts), $)
    ],
    path: ($, opts) => __path(Polyline, $, opts),
    path3: ($, opts) => __path(Polyline3, $, opts),
    points: ($, opts) => __points(Polyline, $, opts),
    points3: ($, opts) => __points(Polyline3, $, opts),
    poly: ($, opts) => __points(Polyline, $, opts, true),
    poly3: ($, opts) => __points(Polyline3, $, opts, true)
  }
);
const __points = (ctor, $, opts, close = false) => {
  const pts = vertices($, opts);
  close && pts.push(set([], pts[0]));
  return [new ctor(pts, __attribs($))];
};
const __path = (ctor, $, opts) => {
  const tmp = $.empty();
  tmp.attribs = $.attribs;
  return [$.segments, ...$.subPaths].map((segments) => {
    tmp.segments = segments;
    return __points(ctor, tmp, opts, tmp.closed)[0];
  });
};
export {
  asPolyline
};
