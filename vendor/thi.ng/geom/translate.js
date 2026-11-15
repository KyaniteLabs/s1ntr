import { defmulti } from "@thi.ng/defmulti/defmulti";
import { add, add2, add3 } from "@thi.ng/vectors/add";
import { set2, set3 } from "@thi.ng/vectors/set";
import { AABB } from "./api/aabb.js";
import { Circle } from "./api/circle.js";
import { Ellipse } from "./api/ellipse.js";
import { Ray } from "./api/ray.js";
import { Ray3 } from "./api/ray3.js";
import { Rect } from "./api/rect.js";
import { Sphere } from "./api/sphere.js";
import { Text } from "./api/text.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __segmentTransformer } from "./internal/transform.js";
const translate = defmulti(
  __dispatch,
  {
    bpatch: "points",
    cubic: "points",
    cubic3: "points3",
    complexpoly: "group",
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
    aabb: ($, delta) => new AABB(
      add3([], $.pos, delta),
      set3([], $.size),
      __copyAttribs($.attribs)
    ),
    arc: ($, delta) => {
      const a = $.copy();
      add2(null, a.pos, delta);
      return a;
    },
    circle: ($, delta) => new Circle(add2([], $.pos, delta), $.r, __copyAttribs($.attribs)),
    ellipse: ($, delta) => new Ellipse(
      add2([], $.pos, delta),
      set2([], $.r),
      __copyAttribs($.attribs)
    ),
    extra: ($) => $,
    group: ($, delta) => $.copyTransformed((x) => translate(x, delta)),
    path: ($, delta) => $.copyTransformed(
      __segmentTransformer(
        (geo) => translate(geo, delta),
        (p) => add([], p, delta)
      )
    ),
    points: ($, delta) => $.copyTransformed(
      (points) => points.map((x) => add2([], x, delta))
    ),
    points3: ($, delta) => $.copyTransformed(
      (points) => points.map((x) => add3([], x, delta))
    ),
    ray: ($, delta) => new Ray(add2([], $.pos, delta), $.dir, __copyAttribs($.attribs)),
    ray3: ($, delta) => new Ray3(add3([], $.pos, delta), $.dir, __copyAttribs($.attribs)),
    rect: ($, delta) => new Rect(
      add2([], $.pos, delta),
      set2([], $.size),
      __copyAttribs($.attribs)
    ),
    sphere: ($, delta) => new Sphere(add3([], $.pos, delta), $.r, __copyAttribs($.attribs)),
    text: ($, delta) => new Text(add2([], $.pos, delta), $.body, __copyAttribs($.attribs))
  }
);
export {
  translate
};
