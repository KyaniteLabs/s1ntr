import { isNumberArray } from "./is-number-array.js";
import { isTypedArray } from "./is-typedarray.js";
const isNumericArray = (x) => isNumberArray(x) || isTypedArray(x);
export {
  isNumericArray
};
