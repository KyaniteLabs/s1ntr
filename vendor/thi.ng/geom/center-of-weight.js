import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import {
  centerOfWeight2,
  complexCenterOfWeight2
} from "@thi.ng/geom-poly-utils/center-of-weight";
import { centroid } from "./centroid.js";
import { __dispatch } from "./internal/dispatch.js";
const centerOfWeight = defmulti(
  __dispatch,
  {},
  {
    [DEFAULT]: ($, out) => centroid($, out),
    complexpoly: ($, out) => complexCenterOfWeight2(
      $.boundary.points,
      $.children.map((c) => c.points),
      out
    ),
    poly: ($, out) => centerOfWeight2($.points, out)
  }
);
export {
  centerOfWeight
};
