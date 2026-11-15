const clipPolylineWith = (pred, pts, step = 1, keepLast = true) => {
  const segs = [];
  let last = -1;
  const $terminate = (i) => {
    if (last !== -1) {
      if (keepLast) {
        segs[segs.length - 1].push(pts[i]);
      } else if (segs[segs.length - 1].length < 2) {
        segs.pop();
      }
    }
    last = -1;
  };
  for (let i = 0, n = pts.length - step; i < n; i++) {
    if (pred(pts[i], pts[i + step])) {
      if (last === -1) {
        segs.push([pts[i]]);
        last = i;
      } else {
        segs[segs.length - 1].push(pts[i]);
      }
    } else {
      $terminate(i);
    }
  }
  $terminate(pts.length - step);
  return segs;
};
export {
  clipPolylineWith
};
