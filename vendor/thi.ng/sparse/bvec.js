import { assert } from "@thi.ng/errors/assert";
import { ensureIndex } from "@thi.ng/errors/out-of-bounds";
class SparseBVec {
  /**
   * Creates a SparseBVec from a dense vector of numbers or booleans. Only the
   * indices of truthy or non-zero components are stored.
   *
   * @param dense
   */
  static fromDense(dense) {
    const sparse = [];
    const n = dense.length;
    for (let i = 0; i < n; i++) {
      dense[i] && sparse.push(i);
    }
    return new SparseBVec(n, sparse);
  }
  m;
  data;
  constructor(m, data) {
    this.m = m;
    this.data = data || [];
  }
  copy() {
    return new SparseBVec(this.m, this.data.slice());
  }
  get length() {
    return this.m;
  }
  get nnz() {
    return this.data.length;
  }
  *nzEntries() {
    const d = this.data;
    for (let i = 0, n = d.length; i < n; i++) {
      yield [d[i], 0, 1];
    }
  }
  at(m, safe = true) {
    safe && ensureIndex(m, 0, this.m);
    return ~~this.data.includes(m);
  }
  setAt(m, v, safe = true) {
    safe && ensureIndex(m, 0, this.m);
    const d = this.data;
    for (let i = 0, n = d.length; i < n; i++) {
      if (m < d[i]) {
        v !== 0 && d.splice(i, 0, m);
        return this;
      } else if (m === d[i]) {
        v === 0 && d.splice(i, 1);
        return this;
      }
    }
    v && d.push(m);
    return this;
  }
  binopN(op, n) {
    const { data, m } = this;
    const res = [];
    let v;
    for (let i = 0, j = 0; i < m; i++) {
      v = op(i === data[j] ? (j++, 1) : 0, n);
      v !== 0 && res.push(i);
    }
    return new SparseBVec(this.m, res);
  }
  binop(op, b) {
    this.ensureSize(b);
    const da = this.data;
    const db = b.data;
    const res = [];
    let ia, ib, v;
    for (let i = 0, j = 0, na = da.length, nb = db.length; i < na || j < nb; ) {
      ia = da[i];
      ib = db[j];
      if (ia === ib) {
        v = op(1, 1);
        v !== 0 && res.push(ia);
        i++;
        j++;
      } else if (ib === void 0 || ia < ib) {
        v = op(1, 0);
        v !== 0 && res.push(ia);
        i++;
      } else {
        v = op(0, 1);
        v !== 0 && res.push(ib);
        j++;
      }
    }
    return new SparseBVec(this.m, res);
  }
  and(b) {
    return this.binop((a, b2) => ~~(a && b2), b);
  }
  or(b) {
    return this.binop((a, b2) => ~~(a || b2), b);
  }
  not() {
    return this.binopN((a, b) => a ^ b, 1);
  }
  dot(v) {
    this.ensureSize(v);
    const da = this.data;
    const db = v.data;
    let res = 0;
    let ia, ib;
    for (let i = 0, j = 0, na = da.length, nb = db.length; i < na && j < nb; ) {
      ia = da[i];
      ib = db[j];
      if (ia === ib) {
        res++;
        i++;
        j++;
      } else if (ia < ib) i++;
      else j++;
    }
    return res;
  }
  magSquared() {
    return this.data.length;
  }
  mag() {
    return Math.sqrt(this.data.length);
  }
  toDense() {
    const res = new Array(this.m).fill(0);
    const d = this.data;
    for (let i = 0, n = d.length; i < n; i++) {
      res[d[i]] = 1;
    }
    return res;
  }
  toString() {
    return `[${this.toDense().join(",")}]`;
  }
  ensureSize(v) {
    assert(this.m === v.m, `wrong vector size: ${v.m}`);
  }
}
export {
  SparseBVec
};
