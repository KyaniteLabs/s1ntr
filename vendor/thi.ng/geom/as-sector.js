import { copy } from "@thi.ng/vectors/copy";
import { Line } from "./api/line.js";
import { Path } from "./api/path.js";
import { __copyAttribs } from "./internal/copy.js";
const asSector = (arc, attribs) => new Path(
  [
    { type: "m", point: copy(arc.pos) },
    { type: "l", geo: new Line([copy(arc.pos), arc.pointAt(0)]) },
    { type: "a", geo: arc },
    { type: "l", geo: new Line([arc.pointAt(1), copy(arc.pos)]) },
    { type: "z" }
  ],
  [],
  attribs || __copyAttribs(arc.attribs)
);
export {
  asSector
};
