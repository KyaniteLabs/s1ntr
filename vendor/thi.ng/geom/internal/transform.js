import { mulV } from "@thi.ng/matrices/mulv";
const __transformedPoints = (pts, mat, op = mulV) => pts.map((p) => op([], mat, p));
const __transformedPointsWith = (pts, fn, op = mulV) => pts.map((p) => op([], fn(p), p));
const __segmentTransformer = (txGeo, txPoint) => (segments) => segments.map(
  (s) => s.geo ? {
    type: s.type,
    geo: txGeo(s.geo)
  } : s.point ? {
    type: s.type,
    point: txPoint(s.point)
  } : { ...s }
);
export {
  __segmentTransformer,
  __transformedPoints,
  __transformedPointsWith
};
