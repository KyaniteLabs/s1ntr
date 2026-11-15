import { MASKS } from "@thi.ng/binary/constants";
import { assert } from "@thi.ng/errors/assert";
import { fit, fit01 } from "@thi.ng/math/fit";
import { inRange } from "@thi.ng/math/interval";
import {
  decode10,
  decode16,
  decode5,
  encode10,
  encode16,
  encode5
} from "./raw.js";
const __prescale = (x, min, max, bits) => {
  assert(inRange(x, min, max), `value ${x} not in range [${min}..${max}]`);
  return Math.round(fit(x, min, max, 0, MASKS[bits]));
};
const encodeScaled5 = (x, min = 0, max = 1) => encode5(__prescale(x, min, max, 5));
const encodeScaled10 = (x, min = 0, max = 1) => encode10(__prescale(x, min, max, 10));
const encodeScaled16 = (x, min = 0, max = 1) => encode16(__prescale(x, min, max, 16));
const decodeScaled5 = (x, min = 0, max = 1) => fit01(decode5(x) / 31, min, max);
const decodeScaled10 = (x, min = 0, max = 1) => fit01(decode10(x) / 1023, min, max);
const decodeScaled16 = (x, min = 0, max = 1) => fit01(decode16(x) / 65535, min, max);
export {
  decodeScaled10,
  decodeScaled16,
  decodeScaled5,
  encodeScaled10,
  encodeScaled16,
  encodeScaled5
};
