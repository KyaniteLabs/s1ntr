import { centroid } from "@thi.ng/geom-poly-utils/centroid";
import { addmN } from "@thi.ng/vectors/addmn";
const edgeSplit = (tess, faces, pids) => {
  const points = tess.pointsForIDs(pids);
  const c = tess.addPoint(centroid(points));
  const n = pids.length - 1;
  for (let i = 0; i <= n; i++) {
    const j = i < n ? i + 1 : 0;
    const m = tess.addPoint(addmN([], points[i], points[j], 0.5));
    faces.push([c, pids[i], m], [c, m, pids[j]]);
  }
  return faces;
};
export {
  edgeSplit
};
