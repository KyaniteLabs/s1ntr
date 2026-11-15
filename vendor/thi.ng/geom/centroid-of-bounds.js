import { bounds } from "./bounds.js";
import { centroid } from "./centroid.js";
const centroidOfBounds = (shape, out) => {
  const b = bounds(shape);
  return b ? centroid(b, out) : void 0;
};
export {
  centroidOfBounds
};
