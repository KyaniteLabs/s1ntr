import { peek } from "@thi.ng/arrays/peek";
import { eqDelta } from "@thi.ng/vectors/eqdelta";
import { equals } from "@thi.ng/vectors/equals";
import { Path } from "./api/path.js";
import { Path3 } from "./api/path3.js";
function pathFromCubics(cubics, attribs) {
  return __pathFromCubics(
    cubics[0].dim === 2 ? Path : Path3,
    cubics,
    attribs
  );
}
const __pathFromCubics = (ctor, cubics, attribs) => {
  let subPaths = [];
  let curr;
  let lastP;
  const $beginPath = (c) => {
    curr = [{ type: "m", point: c.points[0] }];
    subPaths.push(curr);
  };
  for (const c of cubics) {
    if (!(lastP && equals(lastP, c.points[0]))) $beginPath(c);
    curr.push({ type: "c", geo: c });
    lastP = c.points[3];
  }
  const path = new ctor(
    subPaths[0],
    subPaths.slice(1),
    attribs || cubics[0].attribs
  );
  const segments = path.segments;
  if (segments.length > 1 && eqDelta(segments[0].point, peek(peek(segments).geo.points))) {
    path.close();
  }
  return path;
};
export {
  pathFromCubics
};
