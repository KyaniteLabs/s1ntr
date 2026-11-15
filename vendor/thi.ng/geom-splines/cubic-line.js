import { mixN } from "@thi.ng/vectors/mixn";
import { set } from "@thi.ng/vectors/set";
const cubicFromLine = (a, b) => [
  set([], a),
  mixN([], a, b, 1 / 3),
  mixN([], b, a, 1 / 3),
  set([], b)
];
export {
  cubicFromLine
};
