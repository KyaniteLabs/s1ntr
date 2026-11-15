import { ComplexPolygon } from "./api/complex-polygon.js";
import { asPolygon } from "./as-polygon.js";
const complexPolygonFromPath = (path, opts, attribs) => {
  const [boundary, ...children] = asPolygon(path, opts);
  return new ComplexPolygon(boundary, children, attribs || boundary.attribs);
};
export {
  complexPolygonFromPath
};
