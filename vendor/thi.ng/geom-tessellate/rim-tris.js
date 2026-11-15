import { addmN } from "@thi.ng/vectors/addmn";
const rimTris = (tess, faces, pids) => {
  const points = tess.pointsForIDs(pids);
  const n = pids.length - 1;
  const mids = [
    tess.addPoint(addmN([], points[n], points[0], 0.5))
  ];
  let mprev = mids[0];
  for (let i = 0; i <= n; i++) {
    let m;
    if (i < n) {
      m = tess.addPoint(addmN([], points[i], points[i + 1], 0.5));
      mids.push(m);
    } else {
      m = mids[0];
    }
    faces.push([mprev, pids[i], m]);
    mprev = m;
  }
  faces.push(mids);
  return faces;
};
export {
  rimTris
};
