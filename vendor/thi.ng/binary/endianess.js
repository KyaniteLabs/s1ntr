import { F32, F64, I16, I32, I64, I8, U16, U32, U64, U8 } from "./buffers.js";
const IS_LE = (U32[0] = 1, U8[0] === 1);
const DATAVIEW = {
  getI8: (src, i) => (I8[0] = src[i], I8[0]),
  getU8: (src, i) => src[i] & 255,
  getI16: (src, i, isLE) => __get2(src, i, I16, isLE),
  getU16: (src, i, isLE) => __get2(src, i, U16, isLE),
  getI32: (src, i, isLE) => __get4(src, i, I32, isLE),
  getU32: (src, i, isLE) => __get4(src, i, U32, isLE) >>> 0,
  getI64: (src, i, isLE) => __get8(src, i, I64, isLE),
  getU64: (src, i, isLE) => __get8(src, i, U64, isLE),
  getF32: (src, i, isLE) => __get4(src, i, F32, isLE),
  getF64: (src, i, isLE) => __get8(src, i, F64, isLE),
  setI8: (data, addr, x) => {
    I8[0] = x;
    data[addr] = U8[0];
  },
  setU8: (data, addr, x) => {
    data[addr] = x & 255;
  },
  setI16: (data, addr, x, isLE) => {
    I16[0] = x;
    __set2(data, addr, isLE);
  },
  setU16: (data, addr, x, isLE) => {
    U16[0] = x;
    __set2(data, addr, isLE);
  },
  setI32: (data, addr, x, isLE) => {
    I32[0] = x;
    __set4(data, addr, isLE);
  },
  setU32: (data, addr, x, isLE) => {
    U32[0] = x;
    __set4(data, addr, isLE);
  },
  setF32: (data, addr, x, isLE) => {
    F32[0] = x;
    __set4(data, addr, isLE);
  },
  setF64: (data, addr, x, isLE) => {
    F64[0] = x;
    __set8(data, addr, isLE);
  },
  setI64: (data, addr, x, isLE) => {
    I64[0] = x;
    __set8(data, addr, isLE);
  },
  setU64: (data, addr, x, isLE) => {
    U64[0] = x;
    __set8(data, addr, isLE);
  }
};
const __get2 = (src, i, view, isLE = true) => isLE !== IS_LE ? (U8[1] = src[i], U8[0] = src[i + 1], view[0]) : (U8[0] = src[i], U8[1] = src[i + 1], view[0]);
const __get4 = (src, i, view, isLE = true) => isLE !== IS_LE ? (U8[3] = src[i], U8[2] = src[i + 1], U8[1] = src[i + 2], U8[0] = src[i + 3], view[0]) : (U8[0] = src[i], U8[1] = src[i + 1], U8[2] = src[i + 2], U8[3] = src[i + 3], view[0]);
const __get8 = (src, i, view, isLE = true) => isLE !== IS_LE ? (U8[7] = src[i], U8[6] = src[i + 1], U8[5] = src[i + 2], U8[4] = src[i + 3], U8[3] = src[i + 4], U8[2] = src[i + 5], U8[1] = src[i + 6], U8[0] = src[i + 7], view[0]) : (U8[0] = src[i], U8[1] = src[i + 1], U8[2] = src[i + 2], U8[3] = src[i + 3], U8[4] = src[i + 4], U8[5] = src[i + 5], U8[6] = src[i + 6], U8[7] = src[i + 7], view[0]);
const __set2 = (data, addr, isLE = true) => {
  if (isLE !== IS_LE) {
    data[addr] = U8[1];
    data[addr + 1] = U8[0];
  } else {
    data[addr] = U8[0];
    data[addr + 1] = U8[1];
  }
};
const __set4 = (data, addr, isLE = true) => {
  if (isLE !== IS_LE) {
    data[addr] = U8[3];
    data[addr + 1] = U8[2];
    data[addr + 2] = U8[1];
    data[addr + 3] = U8[0];
  } else {
    data[addr] = U8[0];
    data[addr + 1] = U8[1];
    data[addr + 2] = U8[2];
    data[addr + 3] = U8[3];
  }
};
const __set8 = (data, addr, isLE = true) => {
  if (isLE !== IS_LE) {
    data[addr] = U8[7];
    data[addr + 1] = U8[6];
    data[addr + 2] = U8[5];
    data[addr + 3] = U8[4];
    data[addr + 4] = U8[3];
    data[addr + 5] = U8[2];
    data[addr + 6] = U8[1];
    data[addr + 7] = U8[0];
  } else {
    data[addr] = U8[0];
    data[addr + 1] = U8[1];
    data[addr + 2] = U8[2];
    data[addr + 3] = U8[3];
    data[addr + 4] = U8[4];
    data[addr + 5] = U8[5];
    data[addr + 6] = U8[6];
    data[addr + 7] = U8[7];
  }
};
export {
  DATAVIEW,
  IS_LE
};
