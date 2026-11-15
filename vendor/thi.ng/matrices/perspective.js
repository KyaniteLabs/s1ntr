import { frustum, frustumBounds } from "./frustum.js";
const perspective = (out, fov, aspect, near, far) => {
  const f = frustumBounds(fov, aspect, near, far);
  return frustum(out, f.left, f.right, f.bottom, f.top, f.near, f.far);
};
export {
  perspective
};
