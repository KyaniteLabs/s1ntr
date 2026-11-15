import { map } from "@thi.ng/transducers/map";
import { copyVectors } from "@thi.ng/vectors/copy";
import { __copyAttribs } from "./copy.js";
const __pointArraysAsShapes = (ctor, points, attribs, copyPoints = true) => points ? [
  ...map(
    (pts) => new ctor(
      copyPoints ? copyVectors(pts) : pts,
      __copyAttribs(attribs)
    ),
    points
  )
] : void 0;
export {
  __pointArraysAsShapes
};
