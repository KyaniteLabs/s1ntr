import { divN as _divN, divN4 } from "@thi.ng/vectors/divn";
import { $div } from "@thi.ng/vectors/ops";
import { defMathN } from "./defmath.js";
const divN = _divN;
const divN22 = divN4;
const [divN23, divN33, divN44] = defMathN($div);
export {
  divN,
  divN22,
  divN23,
  divN33,
  divN44
};
