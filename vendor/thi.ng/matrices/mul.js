import { mul as _mul, mul4 } from "@thi.ng/vectors/mul";
import { $mul } from "@thi.ng/vectors/ops";
import { defMath } from "./defmath.js";
const mul = _mul;
const mul22 = mul4;
const [mul23, mul33, mul44] = defMath($mul);
export {
  mul,
  mul22,
  mul23,
  mul33,
  mul44
};
