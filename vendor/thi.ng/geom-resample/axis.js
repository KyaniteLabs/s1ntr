import { intersectRayPolyline } from "@thi.ng/geom-isec/ray-poly";
const sampleUniformX = (pts, x1, x2, step = 1, startY = -1) => {
  const res = [];
  for (let x = x1; x <= x2; x += step) {
    res.push(
      intersectRayPolyline([x, startY], [0, 1], pts, false).isec[0]
    );
  }
  return res;
};
const sampleUniformY = (pts, y1, y2, step = 1, startX = -1) => {
  const res = [];
  for (let y = y1; y <= y2; y += step) {
    res.push(
      intersectRayPolyline([startX, y], [1, 0], pts, false).isec[0]
    );
  }
  return res;
};
export {
  sampleUniformX,
  sampleUniformY
};
