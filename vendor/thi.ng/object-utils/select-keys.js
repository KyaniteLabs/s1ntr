import { empty } from "./empty.js";
const selectKeysMap = (src, ks) => {
  const dest = empty(src, Map);
  for (const k of ks) {
    src.has(k) && dest.set(k, src.get(k));
  }
  return dest;
};
const selectDefinedKeysMap = (src, ks) => {
  const dest = empty(src, Map);
  for (const k of ks) {
    const val = src.get(k);
    if (val != null) dest.set(k, val);
  }
  return dest;
};
const selectKeysObj = (src, ks) => {
  const dest = {};
  for (const k of ks) {
    src.hasOwnProperty(k) && (dest[k] = src[k]);
  }
  return dest;
};
const selectDefinedKeysObj = (src, ks) => {
  const res = {};
  for (const k of ks) {
    const val = src[k];
    if (val != null) res[k] = val;
  }
  return res;
};
export {
  selectDefinedKeysMap,
  selectDefinedKeysObj,
  selectKeysMap,
  selectKeysObj
};
