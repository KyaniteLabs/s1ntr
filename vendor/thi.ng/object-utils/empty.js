import { implementsFunction } from "@thi.ng/checks/implements-function";
const empty = (x, ctor) => implementsFunction(x, "empty") ? x.empty() : new (x[Symbol.species] || ctor)();
export {
  empty
};
