import { unsupportedOp } from "@thi.ng/errors/unsupported";
import { Arc } from "../api/arc.js";
const __ensureNoArc = (x) => x instanceof Arc && unsupportedOp("path must not contain arcs, use normalizedPath() first");
export {
  __ensureNoArc
};
