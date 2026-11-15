import { set4 } from "@thi.ng/vectors/set";
const mat22to23 = (out, m22) => (!out && (out = []), set4(out, m22), out[4] = out[5] = 0, out);
export {
  mat22to23
};
