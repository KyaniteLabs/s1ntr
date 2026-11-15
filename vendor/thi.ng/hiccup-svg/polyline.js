import { fattribs, fpoints } from "./format.js";
const polyline = (pts, attribs, ...body) => [
  "polyline",
  fattribs({
    fill: "none",
    points: fpoints(pts),
    ...attribs
  }),
  ...body
];
export {
  polyline
};
