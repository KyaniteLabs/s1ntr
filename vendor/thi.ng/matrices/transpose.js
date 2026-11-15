import { setC, setC4 } from "@thi.ng/vectors/setc";
const transpose22 = (out, m) => setC4(out || [], m[0], m[2], m[1], m[3]);
const transpose33 = (out, m) => setC(out || [], m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]);
const transpose44 = (out, m) => setC(
  out || [],
  m[0],
  m[4],
  m[8],
  m[12],
  m[1],
  m[5],
  m[9],
  m[13],
  m[2],
  m[6],
  m[10],
  m[14],
  m[3],
  m[7],
  m[11],
  m[15]
);
export {
  transpose22,
  transpose33,
  transpose44
};
