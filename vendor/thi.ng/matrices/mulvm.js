import { dot2, dot3, dot4 } from "@thi.ng/vectors/dot";
import { dotS2, dotS3, dotS4 } from "@thi.ng/vectors/dots";
import { setC2, setC3, setC4 } from "@thi.ng/vectors/setc";
const mulVM22 = (out, v, m) => setC2(out, dot2(v, m), dotS2(v, m, 0, 2));
const mulVM23 = mulVM22;
const mulVM33 = (out, v, m) => setC3(out, dot3(v, m), dotS3(v, m, 0, 3), dotS3(v, m, 0, 6));
const mulVM44 = (out, v, m) => setC4(
  out,
  dot4(v, m),
  dotS4(v, m, 0, 4),
  dotS4(v, m, 0, 8),
  dotS4(v, m, 0, 12)
);
export {
  mulVM22,
  mulVM23,
  mulVM33,
  mulVM44
};
