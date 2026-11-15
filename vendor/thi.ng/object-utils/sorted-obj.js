import { asObject } from "./as-object.js";
const sortedObject = (obj) => asObject(
  Object.entries(obj).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
);
export {
  sortedObject
};
