import { isArrayOf } from "./is-array-of.js";
import { isPlainObject } from "./is-plain-object.js";
const isPlainObjectArray = isArrayOf(isPlainObject);
export {
  isPlainObjectArray
};
