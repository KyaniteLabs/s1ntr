import { setS2, setS3, setS4 } from "@thi.ng/vectors/sets";
import { vop } from "@thi.ng/vectors/vop";
const row = vop(1);
const row22 = row.add(4, (out, m, n) => setS2(out, m, 0, n, 1, 2));
const row23 = row.add(6, (out, m, n) => setS3(out, m, 0, n, 1, 2));
const row33 = row.add(9, (out, m, n) => setS3(out, m, 0, n, 1, 3));
const row44 = row.add(16, (out, m, n) => setS4(out, m, 0, n, 1, 4));
export {
  row,
  row22,
  row23,
  row33,
  row44
};
