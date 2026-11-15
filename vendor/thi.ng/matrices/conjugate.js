import { setC4 } from "@thi.ng/vectors/setc";
const conjugateQ = (out, a) => setC4(out || a, -a[0], -a[1], -a[2], a[3]);
export {
  conjugateQ
};
