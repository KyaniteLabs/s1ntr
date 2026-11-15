import { implementsFunction } from "@thi.ng/checks/implements-function";
import { isIllegalKey } from "@thi.ng/checks/is-proto-path";
const copy = (x, ctor) => implementsFunction(x, "copy") ? x.copy() : new (x[Symbol.species] || ctor)(x);
const copyObj = (src) => {
  const res = {};
  for (const k in src) {
    !isIllegalKey(k) && (res[k] = src[k]);
  }
  return res;
};
export {
  copy,
  copyObj
};
