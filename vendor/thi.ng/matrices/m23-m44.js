import { setC } from "@thi.ng/vectors/setc";
const mat23to44 = (out, m23) => setC(
  out || [],
  // x
  m23[0],
  m23[1],
  0,
  0,
  // y
  m23[2],
  m23[3],
  0,
  0,
  // z
  0,
  0,
  1,
  0,
  // w
  m23[4],
  m23[5],
  0,
  1
);
export {
  mat23to44
};
