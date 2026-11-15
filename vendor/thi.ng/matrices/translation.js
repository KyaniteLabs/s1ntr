import { setC, setC6 } from "@thi.ng/vectors/setc";
const translation23 = (m, v) => setC6(m || [], 1, 0, 0, 1, v[0], v[1]);
const translation44 = (m, v) => setC(m || [], 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1);
export {
  translation23,
  translation44
};
