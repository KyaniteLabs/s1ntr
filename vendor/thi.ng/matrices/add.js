import { add as _add, add4 } from "@thi.ng/vectors/add";
import { $add } from "@thi.ng/vectors/ops";
import { defMath } from "./defmath.js";
const add = _add;
const add22 = add4;
const [add23, add33, add44] = defMath($add);
export {
  add,
  add22,
  add23,
  add33,
  add44
};
