import { normalize2 } from "@thi.ng/vectors/normalize";
import { Ray } from "./api/ray.js";
const ray = (pos, dir, attribs, normalize = true) => new Ray(pos, normalize ? normalize2(null, dir) : dir, attribs);
export {
  ray
};
