import { setC4 } from "@thi.ng/vectors/setc";
const mulQ = (out, a, b) => {
  const { 0: ax, 1: ay, 2: az, 3: aw } = a;
  const { 0: bx, 1: by, 2: bz, 3: bw } = b;
  return setC4(
    out || a,
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz
  );
};
export {
  mulQ
};
