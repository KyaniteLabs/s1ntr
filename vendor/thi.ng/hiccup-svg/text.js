import { fattribs, ff } from "./format.js";
const text = (p, body, attribs, ...children) => [
  "text",
  fattribs({
    ...attribs,
    x: ff(p[0]),
    y: ff(p[1])
  }),
  body,
  ...children
];
export {
  text
};
