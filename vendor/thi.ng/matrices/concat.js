import { mulM } from "./mulm.js";
const concat = (out, a, b, ...rest) => rest.reduce((acc, x) => mulM(acc, acc, x), mulM(out, a, b));
export {
  concat
};
