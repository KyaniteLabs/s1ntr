import { assert } from "@thi.ng/errors/assert";
class ASparseMatrix {
  m;
  n;
  constructor(m, n) {
    this.m = m;
    this.n = n;
  }
  trace() {
    assert(this.m === this.n, "matrix is non-square");
    let trace = 0;
    for (let i = this.m; i-- > 0; ) {
      trace += this.at(i, i, false);
    }
    return trace;
  }
  ensureSize(mat) {
    assert(
      mat.m === this.m && mat.n === this.n,
      `incompatible size: (${mat.m},${mat.n})`
    );
  }
}
export {
  ASparseMatrix
};
