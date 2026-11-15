import { isArrayOf } from "./is-array-of.js";
import { isString } from "./is-string.js";
const isStringArray = isArrayOf(isString);
export {
  isStringArray
};
