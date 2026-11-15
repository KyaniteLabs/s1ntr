import { defmulti } from "@thi.ng/defmulti/defmulti";
import { mulV33 } from "@thi.ng/matrices/mulv";
import { rotationAroundAxis33 } from "@thi.ng/matrices/rotation-around-axis";
import { X3, Y3, Z3 } from "@thi.ng/vectors/api";
import { rotateAroundAxis3 } from "@thi.ng/vectors/rotate-around-axis";
import { Ray3 } from "./api/ray3.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __segmentTransformer } from "./internal/transform.js";
const rotateAroundAxis = defmulti(
  __dispatch,
  {
    cubic3: "points3",
    line3: "points3",
    poly3: "points3",
    polyline3: "points3",
    quad3: "points3",
    quadratic3: "points3",
    tri3: "points3"
  },
  {
    group3: ($, axis, theta) => $.copyTransformed(
      (x) => rotateAroundAxis(x, axis, theta)
    ),
    path3: ($, axis, theta) => {
      const mat = rotationAroundAxis33([], axis, theta);
      return $.copyTransformed(
        __segmentTransformer(
          (geo) => rotateAroundAxis(geo, axis, theta),
          (p) => mulV33([], mat, p)
        )
      );
    },
    points3: ($, axis, theta) => {
      const mat = rotationAroundAxis33([], axis, theta);
      return $.copyTransformed(
        (points) => points.map((p) => mulV33([], mat, p))
      );
    },
    ray3: ($, axis, theta) => {
      return new Ray3(
        rotateAroundAxis3([], $.pos, axis, theta),
        rotateAroundAxis3([], $.dir, axis, theta),
        __copyAttribs($.attribs)
      );
    }
  }
);
const rotateX = (shape, theta) => rotateAroundAxis(shape, X3, theta);
const rotateY = (shape, theta) => rotateAroundAxis(shape, Y3, theta);
const rotateZ = (shape, theta) => rotateAroundAxis(shape, Z3, theta);
export {
  rotateAroundAxis,
  rotateX,
  rotateY,
  rotateZ
};
