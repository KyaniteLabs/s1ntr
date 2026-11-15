import { setC } from "@thi.ng/vectors/setc";
const ortho = (out, left, right, bottom, top, near, far) => {
  const dx = 1 / (right - left);
  const dy = 1 / (top - bottom);
  const dz = 1 / (far - near);
  return setC(
    out || [],
    2 * dx,
    0,
    0,
    0,
    0,
    2 * dy,
    0,
    0,
    0,
    0,
    -2 * dz,
    0,
    -(left + right) * dx,
    -(top + bottom) * dy,
    -(far + near) * dz,
    1
  );
};
export {
  ortho
};
