import { Quad } from "./api/quad.js";
import { __pclike } from "./internal/pclike.js";
function quad(...args) {
  return __pclike(Quad, args);
}
export {
  quad
};
