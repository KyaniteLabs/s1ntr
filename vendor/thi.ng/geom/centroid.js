import { defmulti } from "@thi.ng/defmulti/defmulti";
import { centroid as _centroid } from "@thi.ng/geom-poly-utils/centroid";
import { add } from "@thi.ng/vectors/add";
import { addmN, addmN2 } from "@thi.ng/vectors/addmn";
import { maddN } from "@thi.ng/vectors/maddn";
import { mulN } from "@thi.ng/vectors/muln";
import { set } from "@thi.ng/vectors/set";
import { bounds } from "./bounds.js";
import { __dispatch } from "./internal/dispatch.js";
const centroid = defmulti(
  __dispatch,
  {
    arc: "circle",
    bpatch: "points",
    ellipse: "circle",
    cubic: "points",
    cubic3: "points",
    line3: "line",
    path: "group",
    points3: "points",
    poly: "points",
    poly3: "points",
    polyline: "points",
    polyline3: "points",
    quad: "points",
    quad3: "points",
    quadratic: "points",
    quadratic3: "points",
    rect: "aabb",
    sphere: "circle",
    text: "circle",
    tri3: "tri"
  },
  {
    aabb: ($, out) => maddN(out || [], $.size, 0.5, $.pos),
    circle: ($, out) => set(out || [], $.pos),
    complexpoly: ($, out) => _centroid($.boundary.points, out),
    extra: () => void 0,
    group: ($, out) => {
      const b = bounds($);
      return b ? centroid(b, out) : void 0;
    },
    line: ({ points }, out) => addmN2(out || [], points[0], points[1], 0.5),
    points: ($, out) => _centroid($.points, out),
    plane: ($, out) => mulN(out || [], $.normal, $.w),
    tri: ({ points: [a, b, c] }, out) => addmN(null, add(out || [], a, b), c, 1 / 3)
  }
);
export {
  centroid
};
