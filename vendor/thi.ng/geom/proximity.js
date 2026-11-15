import { dist as $dist } from "@thi.ng/vectors/dist";
import { closestPoint } from "./closest-point.js";
const proximity = (shape, p, dist = $dist) => {
  const q = closestPoint(shape, p);
  return q ? dist(p, q) : void 0;
};
export {
  proximity
};
