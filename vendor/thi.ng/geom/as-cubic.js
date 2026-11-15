import { defmulti } from "@thi.ng/defmulti/defmulti";
import { unsupportedOp } from "@thi.ng/errors/unsupported";
import {
  closedCubicFromBreakPoints,
  openCubicFromBreakPoints
} from "@thi.ng/geom-splines/cubic-from-breakpoints";
import {
  closedCubicFromControlPoints,
  openCubicFromControlPoints
} from "@thi.ng/geom-splines/cubic-from-controlpoints";
import { cubicHobby2 } from "@thi.ng/geom-splines/cubic-hobby";
import { TAU } from "@thi.ng/math/api";
import { concat } from "@thi.ng/transducers/concat";
import { flatten1 } from "@thi.ng/transducers/flatten1";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { Cubic } from "./api/cubic.js";
import { Cubic3 } from "./api/cubic3.js";
import { arc } from "./arc.js";
import { asPolygon } from "./as-polygon.js";
import { cubicFromArc, cubicFromLine, cubicFromQuadratic } from "./cubic.js";
import { cubicFromLine3, cubicFromQuadratic3 } from "./cubic3.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
const asCubic = defmulti(
  __dispatch,
  {
    cubic3: "cubic",
    ellipse: "circle",
    group3: "group",
    quad: "poly",
    quad3: "poly3",
    rect: "$aspoly",
    tri: "poly",
    tri3: "poly3"
  },
  {
    $aspoly: ($, opts) => asCubic(asPolygon($)[0], opts),
    arc: cubicFromArc,
    bpatch: ({ points, attribs }, opts) => [
      [0, 4],
      [12, 1],
      [15, -4],
      [3, -1]
    ].map(
      ([i, s]) => new Cubic(
        [
          points[i],
          points[i + s],
          points[i + 2 * s],
          points[i + 3 * s]
        ],
        __attribs(opts, attribs)
      )
    ),
    circle: ($, opts) => asCubic(
      arc(
        $.pos,
        $.r,
        0,
        0,
        TAU,
        true,
        true,
        __attribs(opts, $.attribs)
      )
    ),
    complexpoly: ({ boundary, children, attribs }, opts) => [
      ...mapcat(
        (x) => asCubic(x, opts).map(
          (x2) => (x2.attribs = __attribs(opts, attribs), x2)
        ),
        [boundary, ...children]
      )
    ],
    cubic: ($, opts) => {
      const res = $.copy();
      if (opts?.attribs === false) res.attribs = void 0;
      return [res];
    },
    extra: () => [],
    group: ($, opts) => [
      ...mapcat((x) => asCubic(x, opts), $.children)
    ],
    line: ({ points, attribs }, opts) => [
      cubicFromLine(points[0], points[1], __attribs(opts, attribs))
    ],
    line3: ({ points, attribs }, opts) => [
      cubicFromLine3(points[0], points[1], __attribs(opts, attribs))
    ],
    path: ($) => [
      ...mapcat(
        (segment) => segment.geo ? asCubic(segment.geo) : null,
        concat($.segments, flatten1($.subPaths))
      )
    ],
    poly: ($, opts) => __polyCubic(Cubic, $, opts, {
      default: closedCubicFromControlPoints,
      break: closedCubicFromBreakPoints,
      hobby: (pts, scale) => cubicHobby2(pts, true, scale)
    }),
    poly3: ($, opts) => __polyCubic(Cubic3, $, opts, {
      default: closedCubicFromControlPoints
    }),
    polyline: ($, opts) => __polyCubic(Cubic, $, opts, {
      default: openCubicFromControlPoints,
      break: openCubicFromBreakPoints,
      hobby: (pts, scale) => cubicHobby2(pts, false, scale)
    }),
    polyline3: ($, opts) => __polyCubic(Cubic3, $, opts, {
      default: openCubicFromControlPoints
    }),
    quadratic: ({ points: [a, b, c], attribs }, opts) => [
      cubicFromQuadratic(a, b, c, __attribs(opts, attribs))
    ],
    quadratic3: ({ points: [a, b, c], attribs }, opts) => [
      cubicFromQuadratic3(a, b, c, __attribs(opts, attribs))
    ]
  }
);
const __polyCubic = (ctor, { points, attribs }, opts, conversions) => {
  opts = { mode: "default", uniform: false, scale: 1 / 3, ...opts };
  const fn = conversions[opts.mode];
  if (!fn) unsupportedOp(`conversion mode: ${opts.mode}`);
  return fn(points, opts.scale, opts.uniform).map(
    (pts) => new ctor(pts, __attribs(opts, attribs))
  );
};
const __attribs = (opts, attribs) => attribs && opts?.attribs !== false ? __copyAttribs(attribs) : void 0;
export {
  asCubic
};
