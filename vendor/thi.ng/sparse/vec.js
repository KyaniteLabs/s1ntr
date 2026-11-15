import { assert } from "@thi.ng/errors/assert";
import { ensureIndex } from "@thi.ng/errors/out-of-bounds";
const ADD = (a, b) => a + b;
const SUB = (a, b) => a - b;
const MUL = (a, b) => a * b;
const DIV = (a, b) => a / b;
class SparseVec {
  static fromDense(dense) {
    const sparse = [];
    const n = dense.length;
    for (let i = 0; i < n; i++) {
      const v = dense[i];
      v !== 0 && sparse.push(i, v);
    }
    return new SparseVec(n, sparse);
  }
  m;
  data;
  constructor(m, data) {
    this.m = m;
    this.data = data || [];
  }
  copy() {
    return new SparseVec(this.m, this.data.slice());
  }
  get length() {
    return this.m;
  }
  get nnz() {
    return this.data.length >>> 1;
  }
  *nzEntries() {
    const d = this.data;
    for (let i = 0, n = d.length; i < n; i += 2) {
      yield [d[i], 0, d[i + 1]];
    }
  }
  at(m, safe = true) {
    safe && ensureIndex(m, 0, this.m);
    const d = this.data;
    for (let i = 0, n = d.length; i < n && d[i] <= m; i += 2) {
      if (m === d[i]) {
        return d[i + 1];
      }
    }
    return 0;
  }
  setAt(m, v, safe = true) {
    safe && ensureIndex(m, 0, this.m);
    const d = this.data;
    for (let i = 0, n = d.length; i < n; i += 2) {
      if (m < d[i]) {
        v !== 0 && d.splice(i, 0, m, v);
        return this;
      } else if (m === d[i]) {
        v !== 0 ? d[i + 1] = v : d.splice(i, 2);
        return this;
      }
    }
    v !== 0 && d.push(m, v);
    return this;
  }
  binopN(op, n) {
    const { data, m } = this;
    const res = [];
    for (let i = 0, j = 0, k = data[j]; i < m; i++) {
      let v = op(i === k ? (j += 2, k = data[j], data[j - 1]) : 0, n);
      v !== 0 && res.push(i, v);
    }
    return new SparseVec(this.m, res);
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
        v = op(da[i + 1], db[j + 1]);
        v !== 0 && res.push(ia, v);
        i += 2;
        j += 2;
      } else if (ib === void 0 || ia < ib) {
        v = op(da[i + 1], 0);
        v !== 0 && res.push(ia, v);
        i += 2;
      } else {
        v = op(0, db[j + 1]);
        v !== 0 && res.push(ib, v);
        j += 2;
      }
    }
    return new SparseVec(this.m, res);
  }
  add(v) {
    return this.binop(ADD, v);
  }
  sub(v) {
    return this.binop(SUB, v);
  }
  mul(v) {
    return this.binop(MUL, v);
  }
  div(v) {
    return this.binop(DIV, v);
  }
  addN(n) {
    return this.binopN(ADD, n);
  }
  subN(n) {
    return this.binopN(SUB, n);
  }
  mulN(n) {
    const d = this.data, l = d.length, res = new Array(l);
    for (let i = 0; i < l; i += 2) {
      res[i] = d[i];
      res[i + 1] = d[i + 1] * n;
    }
    return new SparseVec(this.m, res);
  }
  divN(n) {
    const d = this.data, l = d.length, res = new Array(l);
    for (let i = 0; i < l; i += 2) {
      res[i] = d[i];
      res[i + 1] = d[i + 1] / n;
    }
    return new SparseVec(this.m, res);
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
        res += da[i + 1] * db[j + 1];
        i += 2;
        j += 2;
      } else if (ia < ib) i += 2;
      else j += 2;
    }
    return res;
  }
  magSquared() {
    const d = this.data;
    let mag = 0;
    for (let i = 1, n = d.length; i < n; i += 2) {
      mag += d[i] ** 2;
    }
    return mag;
  }
  mag() {
    return Math.sqrt(this.magSquared());
  }
  normalize(n = 1) {
    const mag = this.magSquared();
    if (mag > 1e-9) {
      n /= Math.sqrt(mag);
      const d = this.data;
      for (let i = 1, l = d.length; i < l; i += 2) {
        d[i] *= n;
      }
    }
    return this;
  }
  toDense() {
    const res = new Array(this.m).fill(0);
    const d = this.data;
    for (let i = 0, n = d.length; i < n; i += 2) {
      res[d[i]] = d[i + 1];
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
  SparseVec
};
