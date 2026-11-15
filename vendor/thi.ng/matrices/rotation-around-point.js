import { concat } from "./concat.js";
import { rotation23 } from "./rotation.js";
import { translation23 } from "./translation.js";
const rotationAroundPoint23 = (out, pos, theta) => concat(
  out,
  translation23([], pos),
  rotation23([], theta),
  translation23([], [-pos[0], -pos[1]])
);
export {
  rotationAroundPoint23
};
