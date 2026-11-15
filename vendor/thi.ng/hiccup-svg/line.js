import { fattribs, ff } from "./format.js";
const line = (a, b, attribs, ...body) => [
  "line",
  fattribs({
    ...attribs,
    x1: ff(a[0]),
    y1: ff(a[1]),
    x2: ff(b[0]),
    y2: ff(b[1])
  }),
  ...body
];
const hline = (y, attribs) => line([-1e6, y], [1e6, y], attribs);
const vline = (x, attribs) => line([x, -1e6], [x, 1e6], attribs);
export {
  hline,
  line,
  vline
};
