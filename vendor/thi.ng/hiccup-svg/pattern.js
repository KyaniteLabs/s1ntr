import { fattribs } from "./format.js";
const pattern = (attribs, ...body) => [
  "pattern",
  fattribs({ ...attribs }),
  ...body
];
export {
  pattern
};
