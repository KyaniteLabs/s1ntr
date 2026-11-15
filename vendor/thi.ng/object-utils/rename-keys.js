import { isArray } from "@thi.ng/checks/is-array";
import { empty } from "./empty.js";
const renameKeysMap = (src, km, out) => {
  out = out || empty(src, Map);
  for (const [k, v] of src) {
    out.set(km.has(k) ? km.get(k) : k, v);
  }
  return out;
};
const renameKeysObj = (src, km, out = {}) => {
  for (const k in src) {
    out[km.hasOwnProperty(k) ? km[k] : k] = src[k];
  }
  return out;
};
const renameTransformedKeys = (src, keys) => {
  if (!src) return {};
  const res = {};
  for (let $k in keys) {
    const spec = keys[$k];
    const [k, fn] = isArray(spec) ? spec : [spec];
    let val = src[$k];
    if (val != null) {
      val = fn ? fn(val, src) : val;
      if (val != null) res[k] = val;
    }
  }
  return res;
};
export {
  renameKeysMap,
  renameKeysObj,
  renameTransformedKeys
};
