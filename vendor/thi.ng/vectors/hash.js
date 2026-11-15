import { floatToUintBits } from "@thi.ng/binary/float";
import { rotateLeft } from "@thi.ng/binary/rotate";
const imul = Math.imul;
const hash = (v, H = M4) => {
  let hash5 = -1;
  for (let i = v.length; i-- > 0; ) {
    hash5 = imul(H, hash5) + __mix(hash5, floatToUintBits(v[i])) >>> 0;
  }
  return hash5;
};
const M1 = 3432918353;
const M2 = 461845907;
const M3 = 3864292196;
const M4 = 2654435761;
const __mix = (h, k) => {
  k = imul(rotateLeft(imul(k, M1) >>> 0, 15), M2) >>> 0;
  return (imul(rotateLeft(h ^ k, 13), 5) >>> 0) + M3 >>> 0;
};
const hash2 = (v) => (imul(v[0], M1) ^ imul(v[1], M2)) >>> 0;
const hashC2 = (x, y) => (imul(x, M1) ^ imul(y, M2)) >>> 0;
const hash3 = (v) => (imul(v[0], M1) ^ imul(v[1], M2) ^ imul(v[2], M3)) >>> 0;
const hashC3 = (x, y, z) => (imul(x, M1) ^ imul(y, M2) ^ imul(z, M3)) >>> 0;
const hash4 = (v) => (imul(v[0], M1) ^ imul(v[1], M2) ^ imul(v[2], M3) ^ imul(v[3], M4)) >>> 0;
const hashC4 = (x, y, z, w) => (imul(x, M1) ^ imul(y, M2) ^ imul(z, M3) ^ imul(w, M4)) >>> 0;
export {
  hash,
  hash2,
  hash3,
  hash4,
  hashC2,
  hashC3,
  hashC4
};
