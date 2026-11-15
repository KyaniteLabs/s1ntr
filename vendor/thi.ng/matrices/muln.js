import { mulN as _mulN, mulN4 } from "@thi.ng/vectors/muln";
import { $mul } from "@thi.ng/vectors/ops";
import { defMathN } from "./defmath.js";
const mulN = _mulN;
const mulN22 = mulN4;
const [mulN23, mulN33, mulN44] = defMathN($mul);
export {
  mulN,
  mulN22,
  mulN23,
  mulN33,
  mulN44
};
