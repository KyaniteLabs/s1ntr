import { empty } from "./empty.js";
import { selectKeysObj } from "./select-keys.js";
import { withoutKeysObj } from "./without-keys.js";
const partitionKeysMap = (src, ks) => {
  const destA = empty(src, Map);
  const destB = empty(src, Map);
  for (const k of ks) {
    (src.has(k) ? destA : destB).set(k, src.get(k));
  }
  return [destA, destB];
};
const partitionKeysObj = (obj, keys) => {
  const $keys = Array.isArray(keys) ? keys : [...keys];
  return [selectKeysObj(obj, $keys), withoutKeysObj(obj, $keys)];
};
export {
  partitionKeysMap,
  partitionKeysObj
};
