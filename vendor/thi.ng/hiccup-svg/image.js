import { fattribs, ff } from "./format.js";
const image = (pos, url, attribs, ...body) => [
  "image",
  fattribs({
    ...attribs,
    // TODO replace w/ SVG2 `href` once Safari supports it
    "xlink:href": url,
    x: ff(pos[0]),
    y: ff(pos[1])
  }),
  ...body
];
export {
  image
};
