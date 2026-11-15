import { align } from "@thi.ng/binary/align";
import { popCountArray } from "@thi.ng/binary/count";
import { bitAnd, bitNot, bitOr, bitXor } from "@thi.ng/binary/logic";
import { assert } from "@thi.ng/errors/assert";
import { binOp, toString } from "./util.js";
class BitField {
  /** Backing byte array */
  data;
  /** Field size in bits (always a multiple of 8) */
  n;
  constructor(bits, buf) {
    const isNumber = typeof bits === "number";
    this.n = align(isNumber ? bits : bits.length, 8);
    const numBytes = this.n >>> 3;
    if (buf) {
      assert(
        numBytes === buf.length,
        `buffer must have length=${this.n >>> 3}`
      );
      this.data = buf;
    } else {
      this.data = new Uint8Array(numBytes);
    }
    !isNumber && this.setRange(0, bits);
  }
  get length() {
    return this.n;
  }
  /**
   * Yields iterator of the field's individual bits.
   */
  *[Symbol.iterator]() {
    const { data, n } = this;
    for (let i = 0; i < n; i++) {
      yield data[i >>> 3] & 1 << (~i & 7) ? 1 : 0;
    }
  }
  /**
   * Yields iterator of positions/indices of all set bits only.
   */
  *positions() {
    const { data, n } = this;
    for (let i = 0; i < n; i += 8) {
      const x = data[i >>> 3];
      if (!x) continue;
      for (let k = 31 - Math.clz32(x); k >= 0; k--) {
        if (x & 1 << k) yield i + 7 - k;
      }
    }
  }
  clear() {
    this.data.fill(0);
  }
  copy() {
    const dest = new BitField(this.n);
    dest.data.set(this.data);
    return dest;
  }
  /**
   * Resizes bitfield to new size given (rounded up to multiples of
   * 8).
   *
   * @param n - new size
   */
  resize(n) {
    n = align(n, 8);
    if (n === this.n) return this;
    const dest = new Uint8Array(n >>> 3);
    dest.set(this.data.slice(0, dest.length));
    this.data = dest;
    this.n = n;
    return this;
  }
  /**
   * Returns a non-zero value if bit `n` is enabled. No bounds
   * checking.
   *
   * @param n - bit number
   */
  at(n) {
    return this.data[n >>> 3] & 1 << (~n & 7);
  }
  /**
   * Enables or disables bit `n`. Returns a non-zero value if the bit
   * was previously enabled. No bounds checking.
   *
   * @param n - bit number
   * @param v - new bit value
   */
  setAt(n, v = true) {
    const id = n >>> 3;
    const mask = 1 << (~n & 7);
    const r = this.data[id] & mask;
    if (v) {
      this.data[id] |= mask;
    } else {
      this.data[id] &= ~mask;
    }
    return r;
  }
  /**
   * Sets bits from `start` index with given `values`. No bounds
   * checking.
   *
   * @param start -
   * @param vals -
   */
  setRange(start, vals) {
    const isString = typeof vals === "string";
    for (let i = 0, n = Math.min(this.n, i + vals.length); i < n; i++) {
      this.setAt(
        start + i,
        isString ? vals[i] === "1" : vals[i]
      );
    }
    return this;
  }
  /**
   * Set bits from `start` until `end` index to given `value`. If `end` is
   * omitted, defaults to end of entire field.
   *
   * @param value
   * @param start
   * @param end
   */
  fill(value, start = 0, end = this.n) {
    const $end = end === this.n ? align(start, 8) : end;
    for (let i = start; i < $end; i++) this.setAt(i, value);
    if (end === this.n) this.data.fill(value ? 255 : 0, $end >>> 3);
    return this;
  }
  /**
   * Inverts bit `n`. Returns a non-zero value if the bit was
   * previously enabled. No bounds checking.
   *
   * @param n - bit number
   */
  toggleAt(n) {
    const id = n >>> 3;
    const mask = 1 << (~n & 7);
    const r = this.data[id] & mask;
    if (r) {
      this.data[id] &= ~mask;
    } else {
      this.data[id] |= mask;
    }
    return r;
  }
  /**
   * Returns number of set bits (1's) in the bitfield.
   */
  popCount() {
    return popCountArray(this.data);
  }
  /**
   * Same as {@link BitField.popCount}, but as normalized ratio/percentage.
   */
  density() {
    return this.popCount() / this.n;
  }
  /**
   * Computes the Jaccard similarity with given `field`. Returns a value in
   * `[0,1]` interval: 1.0 if `a` and `b` are equal, or 0.0 if none of the
   * components match.
   *
   * @remarks
   * If `field` is not a `BitField` instance, one will be created for it. The
   * resulting sizes of both fields MUST be equal.
   *
   * Reference: https://en.wikipedia.org/wiki/Jaccard_index
   *
   * @param field
   */
  similarity(field) {
    const $field = field instanceof BitField ? field : new BitField(field);
    this.ensureSize($field);
    const adata = this.data;
    const bdata = $field.data;
    let numUnion = 0;
    let numIsec = 0;
    for (let i = 0, n = this.n; i < n; i++) {
      const j = i >>> 3;
      const k = 1 << (i & 7);
      const aa = (adata[j] & k) !== 0;
      const bb = (bdata[j] & k) !== 0;
      numUnion += ~~(aa || bb);
      numIsec += ~~(aa && bb);
    }
    return numUnion ? numIsec / numUnion : 0;
  }
  and(field) {
    return this.binOp(field, bitAnd);
  }
  or(field) {
    return this.binOp(field, bitOr);
  }
  xor(field) {
    return this.binOp(field, bitXor);
  }
  not() {
    return this.binOp(this, bitNot);
  }
  /**
   * Returns position of first 0-bit, starting at given `from` search
   * position. Returns -1 if unsuccessful.
   *
   * @param from
   */
  firstZero(from = 0) {
    const { data } = this;
    for (let i = from >>> 3, len = data.length, first = true; i < len; i++) {
      let x = data[i];
      if (first) {
        x |= 255 ^ (1 << 8 - (from & 7)) - 1;
        first = false;
      }
      if (x === 255) continue;
      const b = (i << 3) + Math.clz32(x ^ 255) - 24;
      if (b >= from) return b;
    }
    return -1;
  }
  /**
   * Returns position of first 1-bit, starting at given `from` search
   * position. Returns -1 if unsuccessful.
   *
   * @param from
   */
  firstOne(from = 0) {
    const { data } = this;
    for (let i = from >>> 3, len = data.length, first = true; i < len; i++) {
      let x = data[i];
      if (first) {
        x &= (1 << 8 - (from & 7)) - 1;
        first = false;
      }
      if (!x) continue;
      const b = (i << 3) + Math.clz32(x) - 24;
      if (b >= from) return b;
    }
    return -1;
  }
  toString() {
    return toString(this.data);
  }
  binOp(field, op) {
    this.ensureSize(field);
    binOp(this.data, field.data, op);
    return this;
  }
  ensureSize(field) {
    assert(field.n === this.n, `fields must be same size`);
  }
}
const defBitField = (bits) => new BitField(bits);
export {
  BitField,
  defBitField
};
