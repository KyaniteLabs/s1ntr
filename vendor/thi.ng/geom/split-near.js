import { defmulti } from "@thi.ng/defmulti/defmulti";
import { closestT } from "@thi.ng/geom-closest-point/line";
import { Sampler } from "@thi.ng/geom-resample/sampler";
import { splitCubicNearPoint } from "@thi.ng/geom-splines/cubic-split";
import { quadraticSplitNearPoint } from "@thi.ng/geom-splines/quadratic-split";
import { __dispatch } from "./internal/dispatch.js";
import { __pointArraysAsShapes } from "./internal/points-as-shape.js";
import { __splitLineAt } from "./internal/split.js";
const splitNearPoint = defmulti(
  __dispatch,
  {
    cubic3: "cubic",
    line3: "line",
    polyline3: "polyline",
    quadratic3: "quadratic"
  },
  {
    cubic: ({ attribs, points: [a, b, c, d], constructor: ctor }, p) => __pointArraysAsShapes(
      ctor,
      splitCubicNearPoint(p, a, b, c, d),
      attribs,
      false
    ),
    line: ($, p) => __splitLineAt($, closestT(p, $.points[0], $.points[1])),
    polyline: ({ attribs, points, constructor: ctor }, p) => __pointArraysAsShapes(
      ctor,
      new Sampler(points).splitNear(p),
      attribs
    ),
    quadratic: ({ attribs, points: [a, b, c], constructor: ctor }, p) => __pointArraysAsShapes(
      ctor,
      quadraticSplitNearPoint(p, a, b, c),
      attribs,
      false
    )
  }
);
export {
  splitNearPoint
};
