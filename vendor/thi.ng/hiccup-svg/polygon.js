import { fattribs, fpoints } from "./format.js";
const polygon = (pts, attribs, ...body) => [
  "polygon",
  fattribs({
    ...attribs,
    points: fpoints(pts)
  }),
  ...body
];
export {
  polygon
};
