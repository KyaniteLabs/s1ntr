import { neg2, neg3 } from "@thi.ng/vectors/neg";
import { concat } from "./concat.js";
import { scale23, scale44 } from "./scale.js";
import { translation23, translation44 } from "./translation.js";
const scaleWithCenter23 = (m, p, s) => concat(
  m,
  translation23([], p),
  scale23([], s),
  translation23([], neg2([], p))
);
const scaleWithCenter44 = (m, p, s) => concat(
  m,
  translation44([], p),
  scale44([], s),
  translation44([], neg3([], p))
);
export {
  scaleWithCenter23,
  scaleWithCenter44
};
