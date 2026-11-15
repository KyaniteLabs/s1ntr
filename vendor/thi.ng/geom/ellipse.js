import { Ellipse } from "./api/ellipse.js";
import { __argsVV } from "./internal/args.js";
function ellipse(...args) {
  return new Ellipse(...__argsVV(args));
}
export {
  ellipse
};
