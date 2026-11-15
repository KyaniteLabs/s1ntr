import { decode10, decode16, encode10, encode16 } from "./raw.js";
import {
  decodeScaled10,
  decodeScaled16,
  encodeScaled10,
  encodeScaled16
} from "./scaled.js";
const MIN = [0, 0, 0];
const MAX = [1, 1, 1];
const mux2 = (x, y) => (encode16(x) | encode16(y) << 1) >>> 0;
const mux3 = (x, y, z) => (encode10(x) | encode10(y) << 1 | encode10(z) << 2) >>> 0;
const demux2 = (n) => [decode16(n), decode16(n >>> 1)];
const demux3 = (n) => [
  decode10(n),
  decode10(n >>> 1),
  decode10(n >>> 2)
];
const muxScaled2 = (x, y, minx = 0, maxx = 1, miny = minx, maxy = maxx) => (encodeScaled16(x, minx, maxx) | encodeScaled16(y, miny, maxy) << 1) >>> 0;
const muxScaled3 = (x, y, z, minx = 0, maxx = 1, miny = minx, maxy = maxx, minz = minx, maxz = maxx) => (encodeScaled10(x, minx, maxx) | encodeScaled10(y, miny, maxy) << 1 | encodeScaled10(z, minz, maxz) << 2) >>> 0;
const demuxScaled2 = (n, minx = 0, maxx = 1, miny = minx, maxy = maxx) => [decodeScaled16(n, minx, maxx), decodeScaled16(n >>> 1, miny, maxy)];
const demuxScaled3 = (n, minx = 0, maxx = 1, miny = minx, maxy = maxx, minz = minx, maxz = maxx) => [
  decodeScaled10(n, minx, maxx),
  decodeScaled10(n >>> 1, miny, maxy),
  decodeScaled10(n >>> 2, minz, maxz)
];
const muxScaled2v = (v, min = MIN, max = MAX) => muxScaled2(v[0], v[1], min[0], max[0], min[1], max[1]);
const muxScaled3v = (v, min = MIN, max = MAX) => muxScaled3(
  v[0],
  v[1],
  v[2],
  min[0],
  max[0],
  min[1],
  max[1],
  min[2],
  max[2]
);
const demuxScaled2v = (n, min = MIN, max = MAX) => demuxScaled2(n, min[0], max[0], min[1], max[1]);
const demuxScaled3v = (n, min = MIN, max = MAX) => demuxScaled3(n, min[0], max[0], min[1], max[1], min[2], max[2]);
export {
  demux2,
  demux3,
  demuxScaled2,
  demuxScaled2v,
  demuxScaled3,
  demuxScaled3v,
  mux2,
  mux3,
  muxScaled2,
  muxScaled2v,
  muxScaled3,
  muxScaled3v
};
