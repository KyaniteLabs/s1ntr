import { isPlainObject } from "@thi.ng/checks/is-plain-object";
import { meldObjWith, mergeObjWith } from "./merge-with.js";
const mergeDeepObj = (dest, ...objects) => mergeObjWith(
  (a, b) => isPlainObject(a) && isPlainObject(b) ? mergeDeepObj(a, b) : b,
  dest,
  ...objects
);
const meldDeepObj = (dest, ...objects) => meldObjWith(
  (a, b) => isPlainObject(a) && isPlainObject(b) ? meldDeepObj(a, b) : b,
  dest,
  ...objects
);
export {
  meldDeepObj,
  mergeDeepObj
};
