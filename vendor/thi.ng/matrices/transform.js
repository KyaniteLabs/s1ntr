import { concat } from "./concat.js";
import { mulM44 } from "./mulm.js";
import { quatFromEuler } from "./quat-euler.js";
import { quatToMat44 } from "./quat-m44.js";
import { rotation23 } from "./rotation.js";
import { scale23, scale44 } from "./scale.js";
import { translation23 } from "./translation.js";
const transform23 = (out, translate, rotation, scale) => concat(
  out,
  translation23([], translate),
  rotation23([], rotation),
  scale23([], scale)
);
const transform44 = (out, translate, rotation, scale) => mulM44(
  out,
  quatToMat44(
    out,
    quatFromEuler("zyx", rotation[2], rotation[1], rotation[0]),
    translate
  ),
  scale44([], scale)
);
export {
  transform23,
  transform44
};
