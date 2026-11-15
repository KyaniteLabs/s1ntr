import { addN as _addN, addN4 } from "@thi.ng/vectors/addn";
import { $add } from "@thi.ng/vectors/ops";
import { defMathN } from "./defmath.js";
const addN = _addN;
const addN22 = addN4;
const [addN23, addN33, addN44] = defMathN($add);
export {
  addN,
  addN22,
  addN23,
  addN33,
  addN44
};
