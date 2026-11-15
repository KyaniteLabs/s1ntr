import { sum } from "@thi.ng/vectors/sum";
import { diag } from "./diag.js";
const trace = (m) => sum(diag([], m));
export {
  trace
};
