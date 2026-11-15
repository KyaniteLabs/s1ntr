import { isSet } from "@thi.ng/checks/is-set";
import { empty } from "./empty.js";
const __ensureSet = (x) => isSet(x) ? x : new Set(x);
const withoutKeysMap = (src, keys) => {
  const ks = __ensureSet(keys);
  const dest = empty(src, Map);
  for (const p of src.entries()) {
    const k = p[0];
    !ks.has(k) && dest.set(k, p[1]);
  }
  return dest;
};
const withoutKeysObj = (src, keys) => {
  const ks = __ensureSet(keys);
  const dest = {};
  for (const k in src) {
    src.hasOwnProperty(k) && !ks.has(k) && (dest[k] = src[k]);
  }
  return dest;
};
export {
  withoutKeysMap,
  withoutKeysObj
};
