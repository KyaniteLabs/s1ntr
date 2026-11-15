import { bounds2 } from "@thi.ng/geom-poly-utils/bounds";
import { mapPoint } from "./map-point.js";
import { rectFromMinMax } from "./rect.js";
import { unmapPoint } from "./unmap-point.js";
const warpPoint = (p, dest, src, out) => unmapPoint(dest, mapPoint(src, p), out);
const warpPoints = (pts, dest, src, out = []) => {
  for (let n = pts.length, i = 0; i < n; i++) {
    out.push(unmapPoint(dest, mapPoint(src, pts[i])));
  }
  return out;
};
const warpPointsBPatch = (pts, dest, src, out = []) => {
  src = src || rectFromMinMax(...bounds2(pts));
  for (let i = pts.length; i-- > 0; ) {
    out[i] = dest.unmapPoint(mapPoint(src, pts[i]));
  }
  return out;
};
export {
  warpPoint,
  warpPoints,
  warpPointsBPatch
};
