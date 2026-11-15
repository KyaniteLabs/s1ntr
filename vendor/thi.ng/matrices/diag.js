import { setS2, setS3, setS4 } from "@thi.ng/vectors/sets";
import { vop } from "@thi.ng/vectors/vop";
const diag = vop(1);
const diag22 = diag.add(4, (out, m) => setS2(out, m, 0, 0, 1, 3));
const diag23 = diag.add(6, diag22);
const diag33 = diag.add(9, (out, m) => setS3(out, m, 0, 0, 1, 4));
const diag44 = diag.add(16, (out, m) => setS4(out, m, 0, 0, 1, 5));
export {
  diag,
  diag22,
  diag23,
  diag33,
  diag44
};
