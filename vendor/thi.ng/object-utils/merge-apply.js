import { isFunction } from "@thi.ng/checks/is-function";
import { isIllegalKey } from "@thi.ng/checks/is-proto-path";
import { copy, copyObj } from "./copy.js";
const mergeApplyMap = (src, xforms) => {
  const res = copy(src, Map);
  for (const [k, v] of xforms) {
    res.set(k, isFunction(v) ? v(res.get(k)) : v);
  }
  return res;
};
const mergeApplyObj = (src, xforms) => meldApplyObj(copyObj(src), xforms);
const meldApplyObj = (src, xforms) => {
  for (const k in xforms) {
    if (isIllegalKey(k)) continue;
    const v = xforms[k];
    src[k] = isFunction(v) ? v(src[k]) : v;
  }
  return src;
};
export {
  meldApplyObj,
  mergeApplyMap,
  mergeApplyObj
};
