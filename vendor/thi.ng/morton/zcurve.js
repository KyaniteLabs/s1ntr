import { MASKS } from "@thi.ng/binary/constants";
import { assert } from "@thi.ng/errors/assert";
const ZERO = BigInt(0);
const ONE = BigInt(1);
const MINUS_ONE = BigInt(-1);
class ZCurve {
  /**
   * Encodes a single nD point component as partial Z index.
   *
   * @param x - component value
   * @param bits - bits per component
   * @param dims - number of dimensions
   * @param offset - bit offset (for curr dimension)
   * @param out - existing partial Z result
   */
  static encodeComponent(x, bits, dims, offset, out = ZERO) {
    for (let j = bits; j-- > 0; ) {
      if (x >>> j & 1) {
        out |= ONE << BigInt(j * dims + offset);
      }
    }
    return out;
  }
  /**
   * Decodes a single nD component from given Z index.
   *
   * @param z - Z index
   * @param bits - bits per component
   * @param dims - number of dimensions
   * @param offset - bit offset (for curr dimension)
   */
  static decodeComponent(z, bits, dims, offset) {
    let res = 0;
    for (let j = bits; j-- > 0; ) {
      if (z >> BigInt(j * dims + offset) & ONE) {
        res |= 1 << j;
      }
    }
    return res >>> 0;
  }
  dim;
  bits;
  order;
  masks;
  wipeMasks;
  /**
   * @param dim - dimensions
   * @param bits - number of bits per component
   * @param order - component ordering
   */
  constructor(dim, bits, order) {
    assert(dim >= 2, `unsupported dimensions`);
    assert(bits >= 1 && bits <= 32, `unsupported bits per component`);
    this.dim = dim;
    this.bits = bits;
    if (!order) {
      order = [];
      for (let i = 0; i < dim; i++) order[i] = i;
    }
    this.order = order;
    this.initMasks();
  }
  /**
   * Encodes given nD point as Z index.
   *
   * @param p - point to encode
   */
  encode(p) {
    let res = ZERO;
    const { dim, bits, order } = this;
    for (let i = dim; i-- > 0; ) {
      res = ZCurve.encodeComponent(p[i], bits, dim, order[i], res);
    }
    return res;
  }
  /**
   * Decodes given Z index into point coordinates.
   *
   * @param z - Z index
   * @param out - optional result array
   */
  decode(z, out = []) {
    const { dim, bits, order } = this;
    for (let i = dim; i-- > 0; ) {
      out[i] = ZCurve.decodeComponent(z, bits, dim, order[i]);
    }
    return out;
  }
  /**
   * Decomposes given Z index into individual bit patterns, one per
   * dimension.
   *
   * @remarks
   *
   *
   * @param z -
   * @param out -
   */
  split(z, out = []) {
    for (let i = this.dim; i-- > 0; ) {
      out[i] = z & this.masks[i];
    }
    return out;
  }
  merge(zparts) {
    let res = ZERO;
    for (let i = zparts.length; i-- > 0; ) {
      res |= zparts[i];
    }
    return res;
  }
  /**
   * Yields iterator of Z-curve indices in given nD bounding box.
   *
   * @remarks
   * Uses {@link ZCurve.pointInBox} and {@link ZCurve.bigMin} to efficiently
   * skip Z index sub-ranges outside the box.
   *
   * References:
   * - https://en.wikipedia.org/wiki/Z-order_curve#Use_with_one-dimensional_data_structures_for_range_searching
   * - https://aws.amazon.com/blogs/database/z-order-indexing-for-multifaceted-queries-in-amazon-dynamodb-part-1/
   * - https://aws.amazon.com/blogs/database/z-order-indexing-for-multifaceted-queries-in-amazon-dynamodb-part-2/
   *
   * @param rmin - bbox min point
   * @param rmax - bbox max point
   */
  *range(rmin, rmax) {
    const zmin = this.encode(rmin);
    const zmax = this.encode(rmax);
    const p = new Array(this.dim);
    let xd = zmin;
    while (xd !== MINUS_ONE) {
      this.decode(xd, p);
      if (this.pointInBox(p, rmin, rmax)) {
        yield xd;
        xd++;
      } else {
        xd = this.bigMin(xd, zmin, zmax);
      }
    }
  }
  /**
   * Computes the next valid Z index in bbox defined by `zmin` / `zmax` and
   * greater than `zcurr`. Returns -1 if no further indices are in the box.
   *
   * @remarks
   * Partially based on:
   * https://github.com/statgen/LDServer/blob/develop/core/src/Morton.cpp#L38
   *
   * @param zcurr -
   * @param zmin -
   * @param zmax -
   */
  bigMin(zcurr, zmin, zmax) {
    const dim = this.dim;
    let bigmin = MINUS_ONE;
    let bitPos = dim * this.bits - 1;
    let mask = ONE << BigInt(bitPos);
    do {
      const zminBit = zmin & mask;
      const zmaxBit = zmax & mask;
      const currBit = zcurr & mask;
      const bitMask = 1 << (bitPos / dim | 0);
      if (!currBit) {
        if (!zminBit && zmaxBit) {
          bigmin = this.loadBits(bitMask, bitPos, zmin);
          zmax = this.loadBits(bitMask - 1, bitPos, zmax);
        } else if (zminBit) {
          if (zmaxBit) {
            return zmin;
          } else {
            throw new Error("illegal BIGMIN state");
          }
        }
      } else {
        if (!zminBit) {
          if (zmaxBit) {
            zmin = this.loadBits(bitMask, bitPos, zmin);
          } else {
            return bigmin;
          }
        } else if (!zmaxBit) {
          throw new Error("illegal BIGMIN state");
        }
      }
      bitPos--;
      mask >>= ONE;
    } while (mask);
    return bigmin;
  }
  pointInBox(p, rmin, rmax) {
    for (let i = this.dim; i-- > 0; ) {
      const x = p[i];
      if (x < rmin[i] || x > rmax[i]) return false;
    }
    return true;
  }
  initMasks() {
    const { bits, dim, order } = this;
    this.masks = [];
    for (let i = dim; i-- > 0; ) {
      this.masks[i] = ZCurve.encodeComponent(
        MASKS[bits],
        bits,
        dim,
        order[i]
      );
    }
    this.wipeMasks = [];
    const fullMask = (ONE << BigInt(dim * bits)) - ONE;
    for (let i = dim * bits; i-- > 0; ) {
      this.wipeMasks[i] = ZCurve.encodeComponent(
        MASKS[bits] >>> bits - ((i / dim | 0) + 1),
        bits,
        dim,
        i % dim
      ) ^ fullMask;
    }
  }
  loadBits(mask, bitPos, z) {
    const dim = this.dim;
    return z & this.wipeMasks[bitPos] | ZCurve.encodeComponent(mask, this.bits, dim, bitPos % dim);
  }
}
class ZCurve2 extends ZCurve {
  constructor(bits, order) {
    super(2, bits, order);
  }
  encode(p) {
    const { dim, bits, order } = this;
    return ZCurve.encodeComponent(
      p[1],
      bits,
      dim,
      order[1],
      ZCurve.encodeComponent(p[0], bits, dim, order[0])
    );
  }
  decode(z, out = []) {
    const { dim, bits, order } = this;
    out[0] = ZCurve.decodeComponent(z, bits, dim, order[0]);
    out[1] = ZCurve.decodeComponent(z, bits, dim, order[1]);
    return out;
  }
  pointInBox(p, rmin, rmax) {
    const x = p[0];
    const y = p[1];
    return x >= rmin[0] && x <= rmax[0] && y >= rmin[1] && y <= rmax[1];
  }
}
class ZCurve3 extends ZCurve {
  constructor(bits, order) {
    super(3, bits, order);
  }
  encode(p) {
    const { dim, bits, order } = this;
    return ZCurve.encodeComponent(
      p[2],
      bits,
      dim,
      order[2],
      ZCurve.encodeComponent(
        p[1],
        bits,
        dim,
        order[1],
        ZCurve.encodeComponent(p[0], bits, dim, order[0])
      )
    );
  }
  decode(z, out = []) {
    const { dim, bits, order } = this;
    out[0] = ZCurve.decodeComponent(z, bits, dim, order[0]);
    out[1] = ZCurve.decodeComponent(z, bits, dim, order[1]);
    out[2] = ZCurve.decodeComponent(z, bits, dim, order[2]);
    return out;
  }
  pointInBox(p, rmin, rmax) {
    const x = p[0];
    const y = p[1];
    const z = p[2];
    return x >= rmin[0] && x <= rmax[0] && y >= rmin[1] && y <= rmax[1] && z >= rmin[2] && z <= rmax[2];
  }
}
export {
  ZCurve,
  ZCurve2,
  ZCurve3
};
