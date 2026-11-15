import { vop } from "@thi.ng/vectors/vop";
import { IDENT22, IDENT23, IDENT33, IDENT44 } from "./constants.js";
import { set } from "./set.js";
const identity = vop(0);
const identity22 = identity.add(4, (m) => set(m, IDENT22));
const identity23 = identity.add(6, (m) => set(m, IDENT23));
const identity33 = identity.add(9, (m) => set(m, IDENT33));
const identity44 = identity.add(16, (m) => set(m, IDENT44));
export {
  identity,
  identity22,
  identity23,
  identity33,
  identity44
};
