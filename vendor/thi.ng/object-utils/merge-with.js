import { isIllegalKey } from "@thi.ng/checks/is-proto-path";
import { copy, copyObj } from "./copy.js";
const mergeMapWith = (f, dest, ...maps) => {
  const res = copy(dest, Map);
  for (const x of maps) {
    if (x != null) {
      for (const [k, v] of x) {
        res.set(k, res.has(k) ? f(res.get(k), v) : v);
      }
    }
  }
  return res;
};
const mergeObjWith = (f, dest, ...objects) => meldObjWith(f, copyObj(dest), ...objects);
const meldObjWith = (f, dest, ...objects) => {
  for (const x of objects) {
    if (x != null) {
      for (const k in x) {
        if (isIllegalKey(k)) continue;
        const v = x[k];
        dest[k] = dest.hasOwnProperty(k) ? f(dest[k], v) : v;
      }
    }
  }
  return dest;
};
export {
  meldObjWith,
  mergeMapWith,
  mergeObjWith
};
