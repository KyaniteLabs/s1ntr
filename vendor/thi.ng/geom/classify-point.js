import { defmulti } from "@thi.ng/defmulti/defmulti";
import {
  classifyPointInCircle,
  classifyPointInTriangle2,
  classifyPointPlane,
  classifyPointPolygon,
  classifyPointSegment2
} from "@thi.ng/geom-isec/point";
import { EPS } from "@thi.ng/math/api";
import { __dispatch } from "./internal/dispatch.js";
const classifyPoint = defmulti(
  __dispatch,
  { sphere: "circle" },
  {
    circle: ($, p, eps = EPS) => classifyPointInCircle(p, $.pos, $.r, eps),
    line: ({ points: [a, b] }, p, eps = EPS) => classifyPointSegment2(p, a, b, eps),
    plane: ($, p, eps = EPS) => classifyPointPlane(p, $.normal, $.w, eps),
    poly: ($, p, eps = EPS) => classifyPointPolygon(p, $.points, eps),
    tri: ({ points }, p, eps = EPS) => classifyPointInTriangle2(
      p,
      points[0],
      points[1],
      points[2],
      eps
    )
  }
);
export {
  classifyPoint
};
