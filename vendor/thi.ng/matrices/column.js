import { setS2, setS3, setS4 } from "@thi.ng/vectors/sets";
import { vop } from "@thi.ng/vectors/vop";
const column = vop(1);
const column22 = column.add(
  4,
  (out, m, n) => setS2(out, m, 0, n * 2)
);
const column23 = column.add(6, column22);
const column33 = column.add(
  9,
  (out, m, n) => setS3(out, m, 0, n * 3)
);
const column44 = column.add(
  16,
  (out, m, n) => setS4(out, m, 0, n * 4)
);
export {
  column,
  column22,
  column23,
  column33,
  column44
};
