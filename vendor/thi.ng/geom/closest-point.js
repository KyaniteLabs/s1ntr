import { defmulti } from "@thi.ng/defmulti/defmulti";
import { closestPoint as closestPointArc } from "@thi.ng/geom-arc/closest-point";
import {
  closestPointAABB,
  closestPointRect
} from "@thi.ng/geom-closest-point/box";
import { closestPointCircle } from "@thi.ng/geom-closest-point/circle";
import {
  closestPointPolyline,
  closestPointSegment
} from "@thi.ng/geom-closest-point/line";
import { closestPointPlane } from "@thi.ng/geom-closest-point/plane";
import { closestPointArray } from "@thi.ng/geom-closest-point/points";
import { closestPointCubic } from "@thi.ng/geom-splines/cubic-closest-point";
import { closestPointQuadratic } from "@thi.ng/geom-splines/quadratic-closest-point";
import { add2, add3 } from "@thi.ng/vectors/add";
import { distSq2 } from "@thi.ng/vectors/distsq";
import { set2 } from "@thi.ng/vectors/set";
import { __dispatch } from "./internal/dispatch.js";
const closestPoint = defmulti(
  __dispatch,
  {
    quad: "poly",
    points3: "points",
    sphere: "circle",
    tri: "poly"
  },
  {
    aabb: ($, p, out) => closestPointAABB(p, $.pos, add3([], $.pos, $.size), out),
    arc: ($, p, out) => closestPointArc(p, $.pos, $.r, $.axis, $.start, $.end, out),
    circle: ($, p, out) => closestPointCircle(p, $.pos, $.r, out),
    complexpoly: ($, p, out) => {
      out = closestPointPolyline(p, $.boundary.points, true, out);
      let minD = distSq2(p, out);
      let tmp = [];
      for (const child of $.children) {
        closestPointPolyline(p, child.points, true, tmp);
        const d = distSq2(p, tmp);
        if (d < minD) {
          minD = d;
          set2(out, tmp);
        }
      }
      return out;
    },
    cubic: ({ points }, p, out) => closestPointCubic(
      p,
      points[0],
      points[1],
      points[2],
      points[3],
      out
    ),
    line: ({ points }, p, out) => closestPointSegment(p, points[0], points[1], out),
    path: ($, p, out) => {
      let minD = Infinity;
      const $closestPSegment = (segments) => {
        for (const s of segments) {
          if (!s.geo) continue;
          const q = closestPoint(s.geo, p);
          if (!q) continue;
          const d = distSq2(p, q);
          if (d < minD) {
            minD = d;
            out = set2(out || [], q);
          }
        }
      };
      $closestPSegment($.segments);
      for (const sub of $.subPaths) $closestPSegment(sub);
      return out;
    },
    plane: ($, p, out) => closestPointPlane(p, $.normal, $.w, out),
    points: ($, p, out) => closestPointArray(p, $.points, out),
    poly: ($, p, out) => closestPointPolyline(p, $.points, true, out),
    polyline: ($, p, out) => closestPointPolyline(p, $.points, false, out),
    quadratic: ({ points }, p, out) => closestPointQuadratic(p, points[0], points[1], points[2], out),
    rect: ($, p, out) => closestPointRect(p, $.pos, add2([], $.pos, $.size), out)
  }
);
export {
  closestPoint
};
