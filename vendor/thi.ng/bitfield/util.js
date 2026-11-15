import { B8 } from "@thi.ng/strings/radix";
const toString = (data) => [...data].map(B8).join("");
const binOp = (dest, src, op) => {
  for (let i = src.length; i-- > 0; ) dest[i] = op(src[i], dest[i]);
};
export {
  binOp,
  toString
};
