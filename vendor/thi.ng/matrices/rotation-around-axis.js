import { sincos } from "@thi.ng/math/angle";
import { normalize3 } from "@thi.ng/vectors/normalize";
import { setC } from "@thi.ng/vectors/setc";
import { mat33to44 } from "./m33-m44.js";
const rotationAroundAxis33 = (out, axis, theta, normalize = false) => {
  const [x, y, z] = normalize ? normalize3([], axis) : axis;
  const [s, c] = sincos(theta);
  const t = 1 - c;
  const xs = x * s;
  const ys = y * s;
  const zs = z * s;
  const xt = x * t;
  const yt = y * t;
  const zt = z * t;
  return setC(
    out || [],
    x * xt + c,
    y * xt + zs,
    z * xt - ys,
    x * yt - zs,
    y * yt + c,
    z * yt + xs,
    x * zt + ys,
    y * zt - xs,
    z * zt + c
  );
};
const rotationAroundAxis44 = (out, axis, theta, normalize = false) => mat33to44(out, rotationAroundAxis33([], axis, theta, normalize));
export {
  rotationAroundAxis33,
  rotationAroundAxis44
};
