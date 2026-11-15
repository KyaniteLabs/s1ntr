import { defAdjBitMatrix } from "@thi.ng/adjacency/binary";
import { map } from "@thi.ng/transducers/map";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { partition } from "@thi.ng/transducers/partition";
import { wrapSides } from "@thi.ng/transducers/wrap-sides";
import { Group } from "./api/group.js";
import { Polygon } from "./api/polygon.js";
const groupFromTessellation = (tess, attribs) => new Group(
  attribs,
  tess.faces.map((ids) => new Polygon(tess.pointsForIDs(ids)))
);
const graphFromTessellation = ({ points, faces }, directed = false) => defAdjBitMatrix(
  points.length,
  mapcat((ids) => partition(2, 1, wrapSides(ids, 0, 1)), faces),
  !directed
);
const edgesFromTessellation = (tess) => graphFromTessellation(tess, false).edges();
const edgePointsFromTessellation = (tess) => map(
  (e) => tess.pointsForIDs(e),
  graphFromTessellation(tess, false).edges()
);
export {
  edgePointsFromTessellation,
  edgesFromTessellation,
  graphFromTessellation,
  groupFromTessellation
};
