import { implementsFunction } from "@thi.ng/checks/implements-function";
const derefContext = (ctx, keys) => {
  if (ctx == null || !keys || !keys.length) return ctx;
  const res = { ...ctx };
  for (const k of keys) {
    const v = res[k];
    if (implementsFunction(v, "deref")) res[k] = v.deref();
  }
  return res;
};
export {
  derefContext
};
