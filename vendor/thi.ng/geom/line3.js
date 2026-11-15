import { Line } from "./api/line.js";
import { Line3 } from "./api/line3.js";
import { __pclike } from "./internal/pclike.js";
function line3(...args) {
  return __pclike(Line3, args);
}
export {
  line3
};
