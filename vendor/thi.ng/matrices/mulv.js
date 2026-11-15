import { dotS2, dotS3, dotS4 } from "@thi.ng/vectors/dots";
import { setC2, setC3, setC4 } from "@thi.ng/vectors/setc";
import { vop } from "@thi.ng/vectors/vop";
const mulV = vop(1);
const mulV22 = mulV.add(
  4,
  (out, m, v) => setC2(out || v, dotS2(m, v, 0, 0, 2), dotS2(m, v, 1, 0, 2))
);
const mulV23 = mulV.add(
  6,
  (out, m, v) => setC2(out || v, dotS2(m, v, 0, 0, 2) + m[4], dotS2(m, v, 1, 0, 2) + m[5])
);
const mulV33 = mulV.add(
  9,
  (out, m, v) => setC3(
    out || v,
    dotS3(m, v, 0, 0, 3),
    dotS3(m, v, 1, 0, 3),
    dotS3(m, v, 2, 0, 3)
  )
);
const mulV44 = mulV.add(
  16,
  (out, m, v) => setC4(
    out || v,
    dotS4(m, v, 0, 0, 4),
    dotS4(m, v, 1, 0, 4),
    dotS4(m, v, 2, 0, 4),
    dotS4(m, v, 3, 0, 4)
  )
);
const mulV344 = (out, m, v) => {
  const w = dotS3(m, v, 3, 0, 4) + m[15];
  return w !== 0 ? setC3(
    out || v,
    (dotS3(m, v, 0, 0, 4) + m[12]) / w,
    (dotS3(m, v, 1, 0, 4) + m[13]) / w,
    (dotS3(m, v, 2, 0, 4) + m[14]) / w
  ) : void 0;
};
const mulVQ = (out, q, v) => {
  const { 0: px, 1: py, 2: pz } = v;
  const { 0: qx, 1: qy, 2: qz, 3: qw } = q;
  const ix = qw * px + qy * pz - qz * py;
  const iy = qw * py + qz * px - qx * pz;
  const iz = qw * pz + qx * py - qy * px;
  const iw = -qx * px - qy * py - qz * pz;
  return setC3(
    out || v,
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx
  );
};
export {
  mulV,
  mulV22,
  mulV23,
  mulV33,
  mulV344,
  mulV44,
  mulVQ
};
