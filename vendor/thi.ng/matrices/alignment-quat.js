import { cross3 } from "@thi.ng/vectors/cross";
import { dot3 } from "@thi.ng/vectors/dot";
import { mag3 } from "@thi.ng/vectors/mag";
import { normalize3 } from "@thi.ng/vectors/normalize";
import { quatFromAxisAngle } from "./quat-axis-angle.js";
const alignmentQuat = (from, to, normalize = true) => {
  if (normalize) {
    from = normalize3([], from);
    to = normalize3([], to);
  }
  const axis = cross3([], from, to);
  return quatFromAxisAngle(axis, Math.atan2(mag3(axis), dot3(from, to)));
};
export {
  alignmentQuat
};
