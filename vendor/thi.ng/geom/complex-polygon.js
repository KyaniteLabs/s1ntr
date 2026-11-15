import { ComplexPolygon } from "./api/complex-polygon.js";
import { Polygon } from "./api/polygon.js";
const complexPolygon = (boundary, children, attribs) => new ComplexPolygon(boundary, children, attribs);
export {
  complexPolygon
};
