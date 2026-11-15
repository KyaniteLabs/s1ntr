import { defmulti } from "@thi.ng/defmulti/defmulti";
import { mulV23, mulV344 } from "@thi.ng/matrices/mulv";
import { Path } from "./api/path.js";
import { Path3 } from "./api/path3.js";
import { Points } from "./api/points.js";
import { Points3 } from "./api/points3.js";
import { Quad } from "./api/quad.js";
import { Text } from "./api/text.js";
import { asPath } from "./as-path.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __ensureNoArc } from "./internal/error.js";
import {
  __segmentTransformer,
  __transformedPoints
} from "./internal/transform.js";
import { vertices } from "./vertices.js";
const transform = defmulti(
  __dispatch,
  {
    arc: "$aspath",
    circle: "$aspath",
    complexpoly: "group",
    bpatch: "points",
    cubic: "points",
    cubic3: "points3",
    ellipse: "$aspath",
    group3: "group",
    line: "points",
    line3: "points3",
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
    $aspath: ($, mat) => transform(asPath($), mat),
    extra: ($) => $,
    group: ($, mat) => $.copyTransformed((x) => transform(x, mat)),
    path: ($, mat) => $.copyTransformed(
      __segmentTransformer(
        (geo) => {
          __ensureNoArc(geo);
          return transform(geo, mat);
        },
        (p) => mulV23([], mat, p)
      )
    ),
    path3: ($, mat) => $.copyTransformed(
      __segmentTransformer(
        (geo) => {
          __ensureNoArc(geo);
          return transform(geo, mat);
        },
        (p) => mulV344([], mat, p)
      )
    ),
    points: ($, mat) => $.copyTransformed(
      (points) => __transformedPoints(points, mat, mulV23)
    ),
    points3: ($, mat) => $.copyTransformed(
      (points) => __transformedPoints(points, mat, mulV344)
    ),
    rect: ($, mat) => transform(new Quad(vertices($), __copyAttribs($.attribs)), mat),
    text: ($, mat) => new Text(mulV23([], mat, $.pos), $.body, __copyAttribs($.attribs))
  }
);
export {
  transform
};
