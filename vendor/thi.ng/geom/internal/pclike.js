import { isArray } from "@thi.ng/checks/is-array";
import { assert } from "@thi.ng/errors/assert";
import { __argAttribs } from "./args.js";
const __ensurePCLike = (x) => {
  assert(isArray(x.points), "expected a PCLike shape");
  return x;
};
const __pclike = (ctor, args) => {
  const attr = __argAttribs(args);
  return new ctor(args.length === 1 ? args[0] : args, attr);
};
const __ensureNumVerts = (num, expected) => assert(num === expected, `require ${expected} points`);
export {
  __ensureNumVerts,
  __ensurePCLike,
  __pclike
};
