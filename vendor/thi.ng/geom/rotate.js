import { defmulti } from "@thi.ng/defmulti/defmulti";
import { mulV22 } from "@thi.ng/matrices/mulv";
import { rotation22 } from "@thi.ng/matrices/rotation";
import { rotate as $rotate } from "@thi.ng/vectors/rotate";
import { Circle } from "./api/circle.js";
import { Ray } from "./api/ray.js";
import { Text } from "./api/text.js";
import { asPath } from "./as-path.js";
import { asPolygon } from "./as-polygon.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __ensureNoArc } from "./internal/error.js";
import { __segmentTransformer } from "./internal/transform.js";
const rotate = defmulti(
  __dispatch,
  {
    arc: "$aspath",
    bpatch: "points",
    complexpoly: "group",
    cubic: "points",
    ellipse: "$aspath",
    line: "points",
    poly: "points",
    polyline: "points",
    quad: "points",
    quadratic: "points",
    rect: "$aspoly",
    tri: "points"
  },
  {
    $aspath: ($, theta) => rotate(asPath($), theta),
    $aspoly: ($, theta) => rotate(asPolygon($)[0], theta),
    circle: ($, theta) => new Circle(
      $rotate([], $.pos, theta),
      $.r,
      __copyAttribs($.attribs)
    ),
    extra: ($) => $,
    group: ($, theta) => $.copyTransformed((x) => rotate(x, theta)),
    path: ($, theta) => {
      const mat = rotation22([], theta);
      return $.copyTransformed(
        __segmentTransformer(
          (geo) => {
            __ensureNoArc(geo);
            return rotate(geo, theta);
          },
          (p) => mulV22([], mat, p)
        )
      );
    },
    points: ($, theta) => {
      const mat = rotation22([], theta);
      return $.copyTransformed(
        (points) => points.map((p) => mulV22([], mat, p))
      );
    },
    ray: ($, theta) => new Ray(
      $rotate([], $.pos, theta),
      $rotate([], $.dir, theta),
      __copyAttribs($.attribs)
    ),
    text: ($, theta) => new Text(
      $rotate([], $.pos, theta),
      $.body,
      __copyAttribs($.attribs)
    )
  }
);
export {
  rotate
};
