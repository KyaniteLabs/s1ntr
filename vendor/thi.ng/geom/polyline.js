import { mix } from "@thi.ng/math/mix";
import { map } from "@thi.ng/transducers/map";
import { normRange } from "@thi.ng/transducers/norm-range";
import { cartesian2 } from "@thi.ng/vectors/cartesian";
import { Polyline } from "./api/polyline.js";
const polyline = (pts, attribs) => new Polyline(pts, attribs);
const spiral = (origin, r1, r2, startTheta, endTheta, steps, attribs) => new Polyline(
  [
    ...map(
      (t) => cartesian2(
        null,
        [mix(r1, r2, t), mix(startTheta, endTheta, t)],
        origin
      ),
      normRange(steps - 1)
    )
  ],
  attribs
);
export {
  polyline,
  spiral
};
