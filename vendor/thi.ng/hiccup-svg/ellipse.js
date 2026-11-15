import { fattribs, ff } from "./format.js";
const ellipse = (p, rx, ry, attribs, ...body) => [
  "ellipse",
  fattribs({
    ...attribs,
    cx: ff(p[0]),
    cy: ff(p[1]),
    rx: ff(rx),
    ry: ff(ry)
  }),
  ...body
];
export {
  ellipse
};
