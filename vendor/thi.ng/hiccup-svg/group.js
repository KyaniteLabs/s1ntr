import { fattribs } from "./format.js";
const group = (attribs, ...body) => [
  "g",
  __groupLayerID(fattribs({ ...attribs })),
  ...body
];
const __groupLayerID = (attribs) => {
  if (attribs.__inkscapeLayer) {
    attribs["inkscape:groupmode"] = "layer";
    attribs["inkscape:label"] = attribs.__inkscapeLayer;
    delete attribs.__inkscapeLayer;
  }
  return attribs;
};
export {
  __groupLayerID,
  group
};
