import { deref } from "@thi.ng/api/deref";
import { isFunction } from "@thi.ng/checks/is-function";
const css = (rules) => {
  let css2 = "";
  let v;
  for (const r in rules) {
    v = deref(rules[r]);
    if (isFunction(v)) v = v(rules);
    if (v != null) css2 += `${r}:${v};`;
  }
  return css2;
};
export {
  css
};
