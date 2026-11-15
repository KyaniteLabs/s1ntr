import { intersectLinePolylineAll } from "@thi.ng/geom-isec/line-poly";
import { pointInPolygon2 } from "@thi.ng/geom-isec/point";
import { intersectRayPolylineAll } from "@thi.ng/geom-isec/ray-poly";
import { direction2 } from "@thi.ng/vectors/direction";
const clipLinePoly = (a, b, poly) => {
  const isecs = intersectRayPolylineAll(
    a,
    direction2([], a, b),
    poly,
    true
  ).isec;
  return isecs ? __collectSegments(isecs) : void 0;
};
const clipLineSegmentPoly = (a, b, poly) => {
  const isecs = intersectLinePolylineAll(a, b, poly, true).isec;
  const isAInside = pointInPolygon2(a, poly);
  const isBInside = pointInPolygon2(b, poly);
  if (!isecs) {
    return isAInside && isBInside ? [[a, b]] : void 0;
  }
  isAInside && isecs.unshift(a);
  isBInside && isecs.push(b);
  return __collectSegments(isecs);
};
const clipPolylinePoly = (pts, poly) => {
  let res = [];
  if (pts.length < 2) return res;
  let isAInside = pointInPolygon2(pts[0], poly);
  for (let i = 0, n = pts.length - 1; i < n; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const isBInside = pointInPolygon2(b, poly);
    const isecs = intersectLinePolylineAll(a, b, poly, true).isec;
    if (!isecs) {
      if (isAInside && isBInside) {
        if (res.length) res[res.length - 1].push(b);
        else res.push([a, b]);
      }
    } else {
      isAInside && isecs.unshift(a);
      isBInside && isecs.push(b);
      const [first, ...segments] = __collectSegments(isecs);
      if (isAInside) {
        if (res.length) res[res.length - 1].push(first[1]);
        else res.push(first);
      } else {
        res.push(first);
      }
      res.push(...segments);
    }
    isAInside = isBInside;
  }
  return res;
};
const __collectSegments = (isecs) => {
  const segments = [];
  for (let i = 0, n = isecs.length - 1; i < n; i += 2) {
    segments.push([isecs[i], isecs[i + 1]]);
  }
  return segments;
};
export {
  clipLinePoly,
  clipLineSegmentPoly,
  clipPolylinePoly
};
