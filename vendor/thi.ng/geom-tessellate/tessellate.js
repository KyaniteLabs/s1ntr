import { isFunction } from "@thi.ng/checks/is-function";
import { repeat } from "@thi.ng/transducers/repeat";
import { BasicTessellation } from "./tessellation.js";
function tessellate(points, ...args) {
  return tessellateWith(
    new BasicTessellation(),
    points,
    ...args
  );
}
function tessellateWith(tessel, points, ...args) {
  const fns = isFunction(args[0]) ? repeat(args[0], args[1] ?? 1) : args[0];
  return tessellateFaces(tessel, [tessel.addPoints(points)], fns);
}
const tessellateFaces = (tessel, faces, tessellators) => {
  for (const fn of tessellators) {
    let newFaces = [];
    for (const face of faces) {
      fn(tessel, newFaces, face);
    }
    faces = newFaces;
  }
  tessel.addFaces(faces);
  return tessel;
};
export {
  tessellate,
  tessellateFaces,
  tessellateWith
};
