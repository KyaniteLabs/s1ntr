import { defmulti } from "@thi.ng/defmulti/defmulti";
import {
  intersectCircleCircle,
  testCircleCircle
} from "@thi.ng/geom-isec/circle-circle";
import { intersectLineLine } from "@thi.ng/geom-isec/line-line";
import { intersectLinePolylineAll } from "@thi.ng/geom-isec/line-poly";
import { intersectPlanePlane } from "@thi.ng/geom-isec/plane-plane";
import { intersectRayCircle } from "@thi.ng/geom-isec/ray-circle";
import { intersectRayPlane } from "@thi.ng/geom-isec/ray-plane";
import {
  intersectRayPolyline,
  intersectRayPolylineAll
} from "@thi.ng/geom-isec/ray-poly";
import { intersectRayAABB, intersectRayRect } from "@thi.ng/geom-isec/ray-rect";
import { testRectCircle } from "@thi.ng/geom-isec/rect-circle";
import { testAabbAabb, testRectRect } from "@thi.ng/geom-isec/rect-rect";
import { dist2 } from "@thi.ng/vectors/dist";
import { distSq2 } from "@thi.ng/vectors/distsq";
import { magSq2 } from "@thi.ng/vectors/magsq";
import { normalize2 } from "@thi.ng/vectors/normalize";
import { sub2 } from "@thi.ng/vectors/sub";
import {
  IntersectionType,
  NONE
} from "./api.js";
import { Ray } from "./api/ray.js";
import { __dispatch2 } from "./internal/dispatch.js";
const intersects = defmulti(
  __dispatch2,
  {
    "ray-line": "ray-polyline",
    "ray3-sphere": "ray3-circle",
    "ray-quad": "ray-poly",
    "ray-tri": "ray-poly"
  },
  {
    "aabb-aabb": (a, b) => ({
      type: testAabbAabb(a.pos, a.size, b.pos, b.size) ? IntersectionType.INTERSECT : IntersectionType.NONE
    }),
    "circle-circle": (a, b) => intersectCircleCircle(a.pos, b.pos, a.r, b.r),
    "line-group": ({ points: [a, b] }, group, opts) => {
      const dir = sub2([], b, a);
      const max = magSq2(dir);
      const res = intersects(
        new Ray(a, normalize2(null, dir)),
        group,
        opts
      );
      if (res === NONE) return res;
      res.isec = res.isec.filter((p) => distSq2(a, p) <= max);
      if (res.isec.length) {
        res.alpha = dist2(a, res.isec[0]);
        return res;
      }
      return NONE;
    },
    "line-line": ({ points: a }, { points: b }) => intersectLineLine(a[0], a[1], b[0], b[1]),
    "line-poly": ({ points: a }, poly) => intersectLinePolylineAll(a[0], a[1], poly.points, true),
    "line-polyline": ({ points: a }, poly) => intersectLinePolylineAll(a[0], a[1], poly.points, false),
    "plane-plane": (a, b) => intersectPlanePlane(a.normal, a.w, b.normal, b.w),
    "ray-aabb": (ray, box) => intersectRayAABB(ray.pos, ray.dir, box.pos, box.max()),
    "ray-circle": (ray, sphere) => intersectRayCircle(ray.pos, ray.dir, sphere.pos, sphere.r),
    "ray-group": (ray, { children }, opts) => {
      let minD = Infinity;
      const points = [];
      const all = opts?.all;
      let inside = false;
      for (const child of children) {
        let $res = intersects(ray, child, opts);
        if ($res.type !== IntersectionType.INTERSECT) continue;
        if ($res.inside) inside = true;
        const first = $res.isec[0];
        const alpha = $res.alpha !== void 0 ? $res.alpha : dist2(ray.pos, first);
        if (all) {
          points.push(...$res.isec);
          minD = Math.min(minD, alpha);
        } else if (alpha < minD) {
          minD = alpha;
          points[0] = first;
        }
      }
      return minD < Infinity ? {
        type: IntersectionType.INTERSECT,
        isec: points,
        alpha: minD,
        inside
      } : NONE;
    },
    "ray3-plane": (ray, plane) => intersectRayPlane(ray.pos, ray.dir, plane.normal, plane.w),
    "ray-poly": (ray, poly, opts) => opts?.all ? intersectRayPolylineAll(ray.pos, ray.dir, poly.points, true) : intersectRayPolyline(ray.pos, ray.dir, poly.points, true),
    "ray-polyline": (ray, poly, opts) => opts?.all ? intersectRayPolylineAll(ray.pos, ray.dir, poly.points, false) : intersectRayPolyline(ray.pos, ray.dir, poly.points, false),
    "ray-rect": (ray, rect) => intersectRayRect(ray.pos, ray.dir, rect.pos, rect.max()),
    "rect-circle": (rect, circle) => ({
      type: testRectCircle(rect.pos, rect.size, circle.pos, circle.r) ? IntersectionType.INTERSECT : IntersectionType.NONE
    }),
    "rect-rect": (a, b) => ({
      type: testRectRect(a.pos, a.size, b.pos, b.size) ? IntersectionType.INTERSECT : IntersectionType.NONE
    }),
    "sphere-sphere": (a, b) => ({
      type: testCircleCircle(a.pos, b.pos, a.r, b.r) ? IntersectionType.INTERSECT : IntersectionType.NONE
    })
  }
);
export {
  intersects
};
