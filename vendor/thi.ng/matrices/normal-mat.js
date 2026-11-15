import { invert33, invert44 } from "./invert.js";
import { mat44to33 } from "./m44-m33.js";
import { transpose33, transpose44 } from "./transpose.js";
const normal33 = (out, m) => {
  out = invert33(null, mat44to33(out, m));
  return out ? transpose33(null, out) : void 0;
};
const normal44 = (out, m) => {
  out = invert44(out, m);
  return out ? transpose44(null, out) : void 0;
};
export {
  normal33,
  normal44
};
