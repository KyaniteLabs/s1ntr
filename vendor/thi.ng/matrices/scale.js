import { isNumber } from "@thi.ng/checks/is-number";
import { setC, setC4, setC6 } from "@thi.ng/vectors/setc";
const scale22 = (m, s) => (s = isNumber(s) ? [s, s] : s, setC4(m || [], s[0], 0, 0, s[1]));
const scale23 = (m, s) => (s = isNumber(s) ? [s, s] : s, setC6(m || [], s[0], 0, 0, s[1], 0, 0));
const scale33 = (m, s) => (s = isNumber(s) ? [s, s, s] : s, setC(m || [], s[0], 0, 0, 0, s[1], 0, 0, 0, s[2]));
const scale44 = (m, s) => (s = isNumber(s) ? [s, s, s] : s, setC(
  m || [],
  // x
  s[0],
  0,
  0,
  0,
  // y
  0,
  s[1],
  0,
  0,
  // z
  0,
  0,
  s[2],
  0,
  // w
  0,
  0,
  0,
  s[3] !== void 0 ? s[3] : 1
));
export {
  scale22,
  scale23,
  scale33,
  scale44
};
