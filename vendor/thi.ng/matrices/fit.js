import { maddN2, maddN3 } from "@thi.ng/vectors/maddn";
import { mulN2, mulN3 } from "@thi.ng/vectors/muln";
import { safeDiv2, safeDiv3 } from "@thi.ng/vectors/safe-div";
import { concat } from "./concat.js";
import { scale23, scale44 } from "./scale.js";
import { translation23, translation44 } from "./translation.js";
const fit23 = (out, srcPos, srcSize, destPos, destSize) => concat(
  out,
  translation23(null, maddN2([], destSize, 0.5, destPos)),
  scale23(null, safeDiv2([], destSize, srcSize)),
  translation23(null, mulN2(null, maddN2([], srcSize, 0.5, srcPos), -1))
);
const fit44 = (out, srcPos, srcSize, destPos, destSize) => concat(
  out,
  translation44(null, maddN3([], destSize, 0.5, destPos)),
  scale44(null, safeDiv3([], destSize, srcSize)),
  translation44(null, mulN3(null, maddN3([], srcSize, 0.5, srcPos), -1))
);
export {
  fit23,
  fit44
};
