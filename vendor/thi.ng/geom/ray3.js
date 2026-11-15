import { normalize3 } from "@thi.ng/vectors/normalize";
import { Ray3 } from "./api/ray3.js";
const ray3 = (pos, dir, attribs, normalize = true) => new Ray3(pos, normalize ? normalize3(null, dir) : dir, attribs);
export {
  ray3
};
