import { illegalArity } from "@thi.ng/errors/illegal-arity";
import { DEFAULT, defmulti } from "./defmulti.js";
const defmultiN = (impls, fallback) => {
  const fn = defmulti((...args) => args.length);
  fn.add(DEFAULT, fallback || ((...args) => illegalArity(args.length)));
  for (const id in impls) {
    fn.add(id, impls[id]);
  }
  return fn;
};
export {
  defmultiN
};
