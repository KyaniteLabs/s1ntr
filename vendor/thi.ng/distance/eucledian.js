import { dist, dist2, dist3 } from "@thi.ng/vectors/dist";
import { Untransformed } from "./untransformed.js";
const EUCLEDIAN = new Untransformed(dist);
const EUCLEDIAN1 = new Untransformed((a, b) => Math.abs(a - b));
const EUCLEDIAN2 = new Untransformed(dist2);
const EUCLEDIAN3 = new Untransformed(dist3);
export {
  EUCLEDIAN,
  EUCLEDIAN1,
  EUCLEDIAN2,
  EUCLEDIAN3
};
