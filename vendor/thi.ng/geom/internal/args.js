import { isNumber } from "@thi.ng/checks/is-number";
import { isPlainObject } from "@thi.ng/checks/is-plain-object";
import { vecOf } from "@thi.ng/vectors/vec-of";
const __argAttribs = (args) => {
  if (args.length) {
    const last = args[args.length - 1];
    return isPlainObject(last) ? args.pop() : last == null ? (args.pop(), void 0) : void 0;
  }
};
const __argsVV = (args) => {
  const attr = __argAttribs(args);
  return args.length ? args.length === 2 ? [args[0], args[1], attr] : [void 0, args[0], attr] : [void 0, void 0, attr];
};
const __argsVN = (args) => {
  const attr = __argAttribs(args);
  return args.length ? args.length === 2 ? [args[0], args[1], attr] : isNumber(args[0]) ? [void 0, args[0], attr] : [args[0], void 0, attr] : [void 0, void 0, attr];
};
const __asVec = (x, size = 2) => isNumber(x) ? vecOf(size, x) : x;
export {
  __argAttribs,
  __argsVN,
  __argsVV,
  __asVec
};
