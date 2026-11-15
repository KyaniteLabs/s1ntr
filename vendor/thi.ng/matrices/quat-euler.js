import { X3, Y3, Z3 } from "@thi.ng/vectors/api";
import { mulQ } from "./mulq.js";
import { quatFromAxisAngle } from "./quat-axis-angle.js";
const AXIS_ORDER = {
  xyz: [X3, Y3, Z3],
  yxz: [Y3, X3, Z3],
  xzy: [X3, Z3, Y3],
  zxy: [Z3, X3, Y3],
  yzx: [Y3, Z3, X3],
  zyx: [Z3, Y3, X3]
};
const quatFromEuler = (order, a, b, c) => {
  const [aa, ab, ac] = AXIS_ORDER[order];
  return mulQ(
    null,
    mulQ([], quatFromAxisAngle(aa, a), quatFromAxisAngle(ab, b)),
    quatFromAxisAngle(ac, c)
  );
};
export {
  quatFromEuler
};
