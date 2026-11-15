import { XML_INKSCAPE, XML_SVG, XML_XLINK } from "@thi.ng/prefixes/xml";
import { convertTree } from "./convert.js";
import { fattribs, PRECISION, setPrecision } from "./format.js";
const svg = (attribs, ...body) => {
  attribs = fattribs(
    {
      version: "1.1",
      xmlns: XML_SVG,
      "xmlns:xlink": XML_XLINK,
      "xmlns:inkscape": XML_INKSCAPE,
      ...attribs
    },
    "width",
    "height",
    "stroke-width"
  );
  if (attribs.__convert) {
    delete attribs.__convert;
    let prec;
    if (attribs.__prec != null) {
      prec = PRECISION;
      setPrecision(attribs.__prec);
      delete attribs.__prec;
    }
    body = body.map(convertTree);
    if (prec != null) setPrecision(prec);
  }
  return ["svg", attribs, ...body];
};
export {
  svg
};
