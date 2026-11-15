import { $sub } from "@thi.ng/vectors/ops";
import { sub as _sub, sub4 } from "@thi.ng/vectors/sub";
import { defMath } from "./defmath.js";
const sub = _sub;
const sub22 = sub4;
const [sub23, sub33, sub44] = defMath($sub);
export {
  sub,
  sub22,
  sub23,
  sub33,
  sub44
};
