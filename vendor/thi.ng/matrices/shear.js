import { identity22, identity23, identity33, identity44 } from "./identity.js";
const $ = (f) => (i) => (m, x) => (!m && (m = []), f(m), m[i] = x, m);
const $22 = $(identity22);
const $23 = $(identity23);
const $33 = $(identity33);
const $44 = $(identity44);
const shearX22 = $22(2);
const shearY22 = $22(1);
const shearX23 = $23(2);
const shearY23 = $23(1);
const shearXY33 = $33(3);
const shearXZ33 = $33(6);
const shearYX33 = $33(1);
const shearYZ33 = $33(7);
const shearZX33 = $33(2);
const shearZY33 = $33(5);
const shearXY44 = $44(4);
const shearXZ44 = $44(8);
const shearYX44 = $44(1);
const shearYZ44 = $44(9);
const shearZX44 = $44(2);
const shearZY44 = $44(6);
export {
  shearX22,
  shearX23,
  shearXY33,
  shearXY44,
  shearXZ33,
  shearXZ44,
  shearY22,
  shearY23,
  shearYX33,
  shearYX44,
  shearYZ33,
  shearYZ44,
  shearZX33,
  shearZX44,
  shearZY33,
  shearZY44
};
