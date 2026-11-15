import { defmulti } from "@thi.ng/defmulti/defmulti";
import { Sampler } from "@thi.ng/geom-resample/sampler";
import { cubicSplitAt } from "@thi.ng/geom-splines/cubic-split";
import { quadraticSplitAt } from "@thi.ng/geom-splines/quadratic-split";
import { absDiff } from "@thi.ng/math/abs";
import { PI, TAU } from "@thi.ng/math/api";
import { fit01 } from "@thi.ng/math/fit";
import { set2 } from "@thi.ng/vectors/set";
import { Arc } from "./api/arc.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __pointArraysAsShapes } from "./internal/points-as-shape.js";
import { __splitLineAt } from "./internal/split.js";
const splitAt = defmulti(
  __dispatch,
  {
    cubic3: "cubic",
    line3: "line",
    polyline3: "polyline",
    quadratic3: "quadratic"
  },
  {
    arc: ({ pos, r, start, end, axis, cw, attribs }, t) => {
      const theta = fit01(t, start, end);
      return [
        new Arc(
          set2([], pos),
          set2([], r),
          axis,
          start,
          theta,
          absDiff(start, theta) >= PI,
          cw,
          __copyAttribs(attribs)
        ),
        new Arc(
          set2([], pos),
          set2([], r),
          axis,
          theta,
          end,
          absDiff(theta, end) >= PI,
          cw,
          __copyAttribs(attribs)
        )
      ];
    },
    circle: ({ pos, r, attribs }, t) => {
      const theta = t * TAU;
      return [
        new Arc(
          set2([], pos),
          [r, r],
          0,
          0,
          theta,
          t >= 0.5,
          true,
          __copyAttribs(attribs)
        ),
        new Arc(
          set2([], pos),
          [r, r],
          0,
          theta,
          TAU,
          t < 0.5,
          true,
          __copyAttribs(attribs)
        )
      ];
    },
    cubic: ({ attribs, points: [a, b, c, d], constructor: ctor }, t) => __pointArraysAsShapes(
      ctor,
      cubicSplitAt(a, b, c, d, t),
      attribs,
      false
    ),
    line: __splitLineAt,
    polyline: ({ attribs, points, constructor: ctor }, t) => __pointArraysAsShapes(
      ctor,
      new Sampler(points).splitAt(t),
      attribs
    ),
    quadratic: ({ attribs, points: [a, b, c], constructor: ctor }, t) => __pointArraysAsShapes(
      ctor,
      quadraticSplitAt(a, b, c, t),
      attribs,
      false
    )
  }
);
export {
  splitAt
};
