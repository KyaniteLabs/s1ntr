const F64 = new Float64Array(1);
const F32 = new Float32Array(F64.buffer);
const I8 = new Int8Array(F64.buffer);
const U8 = new Uint8Array(F64.buffer);
const I16 = new Int16Array(F64.buffer);
const U16 = new Uint16Array(F64.buffer);
const I32 = new Int32Array(F64.buffer);
const U32 = new Uint32Array(F64.buffer);
const I64 = new BigInt64Array(F64.buffer);
const U64 = new BigUint64Array(F64.buffer);
export {
  F32,
  F64,
  I16,
  I32,
  I64,
  I8,
  U16,
  U32,
  U64,
  U8
};
