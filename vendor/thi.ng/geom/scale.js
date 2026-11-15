import { isNumber } from "@thi.ng/checks/is-number";
import { defmulti } from "@thi.ng/defmulti/defmulti";
import { unsupportedOp } from "@thi.ng/errors/unsupported";
import { mul, mul2, mul3 } from "@thi.ng/vectors/mul";
import { mulN2, mulN3 } from "@thi.ng/vectors/muln";
import { normalize2, normalize3 } from "@thi.ng/vectors/normalize";
import { AABB } from "./api/aabb.js";
import { Circle } from "./api/circle.js";
import { Ellipse } from "./api/ellipse.js";
import { Ray } from "./api/ray.js";
import { Ray3 } from "./api/ray3.js";
import { Rect } from "./api/rect.js";
import { Sphere } from "./api/sphere.js";
import { Text } from "./api/text.js";
import { __asVec } from "./internal/args.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __segmentTransformer } from "./internal/transform.js";
const scale = defmulti(
  __dispatch,
  {
    bpatch: "points",
    complexpoly: "group",
    cubic: "points",
    cubic3: "points3",
    group3: "group",
    line: "points",
    line3: "points3",
    path3: "path",
    poly: "points",
    poly3: "points3",
    polyline: "points",
    polyline3: "points3",
    quad: "points",
    quad3: "points3",
    quadratic: "points",
    quadratic3: "points3",
    tri: "points",
    tri3: "points3"
  },
  {
    aabb: ($, delta) => {
      delta = __asVec(delta, 3);
      return new AABB(
        mul3([], $.pos, delta),
        mul3([], $.size, delta),
        __copyAttribs($.attribs)
      );
    },
    arc: ($, delta) => {
      delta = __asVec(delta);
      const a = $.copy();
      mul2(null, a.pos, delta);
      mul2(null, a.r, delta);
      return a;
    },
    circle: ($, delta) => isNumber(delta) ? new Circle(
      mulN2([], $.pos, delta),
      $.r * delta,
      __copyAttribs($.attribs)
    ) : new Ellipse(
      mul2([], $.pos, delta),
      mulN2([], delta, $.r),
      __copyAttribs($.attribs)
    ),
    ellipse: ($, delta) => {
      delta = __asVec(delta);
      return new Ellipse(
        mul2([], $.pos, delta),
        mul2([], $.r, delta),
        __copyAttribs($.attribs)
      );
    },
    extra: ($) => $,
    group: ($, delta) => $.copyTransformed((x) => scale(x, delta)),
    path: ($, delta) => {
      delta = __asVec(delta);
      return $.copyTransformed(
        __segmentTransformer(
          (geo) => scale(geo, delta),
          (p) => mul([], p, delta)
        )
      );
    },
    points: ($, delta) => $.copyTransformed(
      (points) => points.map(
        isNumber(delta) ? (x) => mulN2([], x, delta) : (x) => mul2([], x, delta)
      )
    ),
    points3: ($, delta) => $.copyTransformed(
      (points) => points.map(
        isNumber(delta) ? (x) => mulN3([], x, delta) : (x) => mul3([], x, delta)
      )
    ),
    ray: ($, delta) => {
      delta = __asVec(delta);
      return new Ray(
        mul2([], $.pos, delta),
        normalize2(null, mul2([], $.dir, delta)),
        __copyAttribs($.attribs)
      );
    },
    ray3: ($, delta) => {
      delta = __asVec(delta);
      return new Ray3(
        mul3([], $.pos, delta),
        normalize3(null, mul3([], $.dir, delta)),
        __copyAttribs($.attribs)
      );
    },
    rect: ($, delta) => {
      delta = __asVec(delta);
      return new Rect(
        mul2([], $.pos, delta),
        mul2([], $.size, delta),
        __copyAttribs($.attribs)
      );
    },
    sphere: ($, delta) => isNumber(delta) ? new Sphere(
      mulN3([], $.pos, delta),
      $.r * delta,
      __copyAttribs($.attribs)
    ) : unsupportedOp("can't non-uniformly scale sphere"),
    text: ($, delta) => new Text(
      mul2([], $.pos, __asVec(delta)),
      $.body,
      __copyAttribs($.attribs)
    )
  }
);
export {
  scale
};
