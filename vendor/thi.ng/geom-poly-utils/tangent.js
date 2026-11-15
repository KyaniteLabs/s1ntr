import { EPS } from "@thi.ng/math/api";
import { addmN } from "@thi.ng/vectors/addmn";
import { direction } from "@thi.ng/vectors/direction";
import { mag } from "@thi.ng/vectors/mag";
import { mixN } from "@thi.ng/vectors/mixn";
import { normalize } from "@thi.ng/vectors/normalize";
import { perpendicularCCW } from "@thi.ng/vectors/perpendicular";
import { set } from "@thi.ng/vectors/set";
import { sub } from "@thi.ng/vectors/sub";
const tangents = (pts, close = false, scale = 1) => {
  const n = pts.length - 1;
  const res = [];
  for (let i = 1; i <= n; i++) {
    res.push(direction([], pts[i - 1], pts[i], scale));
  }
  res.push(
    close ? direction([], pts[n], pts[0], scale) : set([], res[n - 1])
  );
  return res;
};
const smoothTangents = (pts, close = false, proportional = true, scale = 1) => {
  const res = [];
  const n = pts.length - 1;
  if (n < 1) return res;
  let prev;
  let plen;
  if (close) {
    prev = sub([], pts[0], pts[n]);
    plen = mag(prev);
    normalize(null, prev);
  }
  let t;
  for (let i = 0; i <= n; i++) {
    let curr;
    let clen;
    if (i === n) {
      if (close) {
        curr = sub([], pts[0], pts[i]);
      } else {
        res.push(prev);
        return res;
      }
    } else {
      curr = sub([], pts[i + 1], pts[i]);
    }
    clen = mag(curr);
    normalize(null, curr);
    if (i > 0 || close) {
      t = proportional ? mixN(
        [],
        prev,
        curr,
        Math.min(1, clen / (clen + plen + EPS))
      ) : addmN([], prev, curr, 0.5);
    } else {
      t = set([], curr);
    }
    res.push(normalize(null, t, scale));
    prev = curr;
    plen = clen;
  }
  return res;
};
const bitangents2 = (tangents2) => tangents2.map((t) => perpendicularCCW([], t));
export {
  bitangents2,
  smoothTangents,
  tangents
};
