import { sincos } from "@thi.ng/math/angle";
import { setC, setC4, setC6 } from "@thi.ng/vectors/setc";
const rotation22 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC4(out || [], c, s, -s, c);
};
const rotation23 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC6(out || [], c, s, -s, c, 0, 0);
};
const rotationX33 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC(out || [], 1, 0, 0, 0, c, s, 0, -s, c);
};
const rotationY33 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC(out || [], c, 0, -s, 0, 1, 0, s, 0, c);
};
const rotationZ33 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC(out || [], c, s, 0, -s, c, 0, 0, 0, 1);
};
const rotationX44 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC(out || [], 1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1);
};
const rotationY44 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC(out || [], c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1);
};
const rotationZ44 = (out, theta) => {
  const [s, c] = sincos(theta);
  return setC(out || [], c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
};
export {
  rotation22,
  rotation23,
  rotationX33,
  rotationX44,
  rotationY33,
  rotationY44,
  rotationZ33,
  rotationZ44
};
