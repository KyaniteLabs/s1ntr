import { dot4 } from "@thi.ng/vectors/dot";
import { maddN4 } from "@thi.ng/vectors/maddn";
import { mulN4 } from "@thi.ng/vectors/muln";
import { set4 } from "@thi.ng/vectors/set";
const mixQ = (out, a, b, t, eps = 1e-3) => {
  const d = dot4(a, b);
  if (Math.abs(d) < 1) {
    const theta = Math.acos(d);
    const stheta = Math.sqrt(1 - d * d);
    let u, v;
    if (Math.abs(stheta) < eps) {
      u = v = 0.5;
    } else {
      u = Math.sin(theta * (1 - t)) / stheta;
      v = Math.sin(theta * t) / stheta;
    }
    !out && (out = a);
    return maddN4(out, b, v, mulN4(out, a, u));
  }
  return a !== out ? set4(out, a) : out;
};
export {
  mixQ
};
