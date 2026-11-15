import { Polygon } from "./api/polygon.js";
import { Polyline } from "./api/polyline.js";
import { asPath } from "./as-path.js";
import { asPolygon } from "./as-polygon.js";
import { asPolyline } from "./as-polyline.js";
const smoothPolygon = (points, attribs, pathOpts, polyOpts) => asPolygon(asPath(new Polygon(points, attribs), pathOpts), polyOpts)[0];
const smoothPolyline = (points, attribs, pathOpts, polyOpts) => asPolyline(asPath(new Polyline(points, attribs), pathOpts), polyOpts)[0];
export {
  smoothPolygon,
  smoothPolyline
};
