import { cross2 } from "@thi.ng/vectors/cross";
import { divN2 } from "@thi.ng/vectors/divn";
import { maddN2 } from "@thi.ng/vectors/maddn";
import { msubN2 } from "@thi.ng/vectors/msubn";
import { polyArea2 } from "./area.js";
const centerOfWeight2 = (points, out = []) => {
  const n = points.length - 1;
  let area = 0;
  let x = 0;
  let y = 0;
  let a = points[n];
  let b = points[0];
  for (let i = 0; i <= n; a = b, b = points[++i]) {
    const z = cross2(a, b);
    area += z;
    x += (a[0] + b[0]) * z;
    y += (a[1] + b[1]) * z;
  }
  area = 1 / (area * 3);
  out[0] = x * area;
  out[1] = y * area;
  return out;
};
const complexCenterOfWeight2 = (boundary, children, out) => {
  const outerArea = Math.abs(polyArea2(boundary));
  let innerArea = 0;
  let innerCentroid = [0, 0];
  let tmp = [];
  for (const child of children) {
    const a = Math.abs(polyArea2(child));
    innerArea += a;
    maddN2(innerCentroid, centerOfWeight2(child, tmp), a, innerCentroid);
  }
  return divN2(
    null,
    msubN2(
      out || [],
      centerOfWeight2(boundary, tmp),
      outerArea,
      innerCentroid
    ),
    outerArea - innerArea
  );
};
export {
  centerOfWeight2,
  complexCenterOfWeight2
};
