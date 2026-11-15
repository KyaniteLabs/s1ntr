import { compare } from "./compare.js";
const __key = (k) => typeof k === "function" ? k : (x) => x[k];
function compareByKey(key, cmp = compare) {
  const kfn = __key(key);
  return (x, y) => cmp(kfn(x), kfn(y));
}
function compareByKeys2(a, b, cmpA = compare, cmpB = compare) {
  const ka = __key(a);
  const kb = __key(b);
  return (x, y) => cmpA(ka(x), ka(y)) || cmpB(kb(x), kb(y));
}
function compareByKeys3(a, b, c, cmpA = compare, cmpB = compare, cmpC = compare) {
  const ka = __key(a);
  const kb = __key(b);
  const kc = __key(c);
  return (x, y) => cmpA(ka(x), ka(y)) || cmpB(kb(x), kb(y)) || cmpC(kc(x), kc(y));
}
function compareByKeys4(a, b, c, d, cmpA = compare, cmpB = compare, cmpC = compare, cmpD = compare) {
  const ka = __key(a);
  const kb = __key(b);
  const kc = __key(c);
  const kd = __key(d);
  return (x, y) => cmpA(ka(x), ka(y)) || cmpB(kb(x), kb(y)) || cmpC(kc(x), kc(y)) || cmpD(kd(x), kd(y));
}
export {
  compareByKey,
  compareByKeys2,
  compareByKeys3,
  compareByKeys4
};
