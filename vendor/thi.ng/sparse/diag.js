import { assert } from "@thi.ng/errors/assert";
import { ensureIndex2 } from "@thi.ng/errors/out-of-bounds";
import { ASparseMatrix } from "./amatrix.js";
import { CSC } from "./csc.js";
import { CSR } from "./csr.js";
import { SparseVec } from "./vec.js";
class Diag extends ASparseMatrix {
  static identity(m) {
    return new Diag(new Array(m).fill(1));
  }
  data;
  constructor(data) {
    if (data instanceof SparseVec) {
      super(data.m, data.m);
      this.data = data;
    } else {
      super(data.length, data.length);
      this.data = SparseVec.fromDense(data);
    }
  }
  *nzEntries() {
    for (const e of this.data.nzEntries()) {
      yield [e[0], e[0], e[2]];
    }
  }
  at(m, n, safe = true) {
    safe && ensureIndex2(m, n, this.m, this.n);
    return m === n ? this.data.at(m, false) : 0;
  }
  setAt(m, n, v, safe = true) {
    safe && assert(m === n && m >= 0 && m < this.m, `invalid index: ${m},${n}`);
    this.data.setAt(m, v, false);
    return this;
  }
  nnz() {
    return this.data.length;
  }
  nnzCol(n) {
    return this.data.at(n) !== 0 ? 1 : 0;
  }
  nnzRow(m) {
    return this.nnzCol(m);
  }
  nzColRows(n) {
    return this.data.at(n) !== 0 ? [n] : [];
  }
  nzColVals(n) {
    const x = this.data.at(n);
    return x !== 0 ? [x] : [];
  }
  nzRowCols(m) {
    return this.nzColRows(m);
  }
  nzRowVals(m) {
    return this.nzColVals(m);
  }
  toDense() {
    const { data, n } = this;
    const res = new Array(n * n).fill(0);
    for (let i = 0; i < n; i++) {
      res[i * n + i] = data.at(i, false);
    }
    return res;
  }
  toCSC() {
    return CSC.diag(this.data.toDense());
  }
  toCSR() {
    return CSR.diag(this.data.toDense());
  }
}
export {
  Diag
};
