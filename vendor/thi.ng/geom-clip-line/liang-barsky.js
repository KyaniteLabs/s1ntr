const liangBarsky2 = (a, b, min, max, ca = [], cb = []) => {
  const res = liangBarsky2Raw(
    a[0],
    a[1],
    b[0],
    b[1],
    min[0],
    min[1],
    max[0],
    max[1]
  );
  if (!res) return;
  ca[0] = res[0];
  ca[1] = res[1];
  cb[0] = res[2];
  cb[1] = res[3];
  return [ca, cb, res[4], res[5]];
};
const liangBarsky2Raw = (ax, ay, bx, by, minx, miny, maxx, maxy) => {
  const dx = bx - ax;
  const dy = by - ay;
  let alpha = 0;
  let beta = 1;
  const clip = (p, q) => {
    if (p < 0) {
      const r = q / p;
      if (r > beta) {
        return false;
      }
      if (r > alpha) {
        alpha = r;
      }
    } else if (p > 0) {
      const r = q / p;
      if (r < alpha) {
        return false;
      }
      if (r < beta) {
        beta = r;
      }
    } else if (q < 0) {
      return false;
    }
    return true;
  };
  return clip(-dx, ax - minx) && clip(dx, maxx - ax) && clip(-dy, ay - miny) && clip(dy, maxy - ay) ? [
    alpha * dx + ax,
    alpha * dy + ay,
    beta * dx + ax,
    beta * dy + ay,
    alpha,
    beta
  ] : void 0;
};
export {
  liangBarsky2,
  liangBarsky2Raw
};
