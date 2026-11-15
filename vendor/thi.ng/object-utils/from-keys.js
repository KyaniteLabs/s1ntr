import { isFunction } from "@thi.ng/checks/is-function";
const objectFromKeys = (keys, init) => keys.reduce(
  isFunction(init) ? (acc, k) => (acc[k] = init(k), acc) : (acc, k) => (acc[k] = init, acc),
  {}
);
export {
  objectFromKeys
};
