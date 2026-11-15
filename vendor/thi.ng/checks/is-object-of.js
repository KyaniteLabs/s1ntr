import { isPlainObject } from "./is-plain-object.js";
const isObjectOf = (pred) => (x) => isPlainObject(x) && Object.values(x).every(pred);
export {
  isObjectOf
};
