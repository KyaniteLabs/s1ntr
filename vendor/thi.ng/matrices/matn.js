import { scale22, scale23, scale33, scale44 } from "./scale.js";
const mat22n = (out, n) => scale22(out, n);
const mat23n = (out, n) => scale23(out, n);
const mat33n = (out, n) => scale33(out, n);
const mat44n = (out, n) => scale44(out, [n, n, n, n]);
export {
  mat22n,
  mat23n,
  mat33n,
  mat44n
};
