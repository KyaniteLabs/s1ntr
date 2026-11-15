import { ensureIndex2 } from "@thi.ng/errors/out-of-bounds";
import { CSR } from "@thi.ng/sparse/csr";
import { __into, __invert, __toDot } from "./utils.js";
class AdjacencyMatrix extends CSR {
  undirected;
  constructor(n, data, rows, cols, undirected = false) {
    super(n, n, data, rows, cols);
    this.undirected = undirected;
  }
  *edges() {
    const { cols, rows } = this;
    const directed = !this.undirected;
    for (let i = 0; i < this.m; i++) {
      const jj = rows[i + 1];
      for (let j = rows[i]; j < jj; j++) {
        const k = cols[j];
        if (directed || i <= k) {
          yield [i, k];
        }
      }
    }
  }
  addEdge(from, to) {
    if (!this.at(from, to)) {
      this.setAt(from, to, 1, false);
      this.undirected && this.setAt(to, from, 1, false);
      return true;
    }
    return false;
  }
  removeEdge(from, to) {
    if (this.at(from, to)) {
      this.setAt(from, to, 0, false);
      this.undirected && this.setAt(to, from, 0, false);
      return true;
    }
    return false;
  }
  hasEdge(from, to) {
    return this.at(from, to) !== 0;
  }
  hasVertex(id) {
    return this.degree(id, "inout") > 0;
  }
  numEdges() {
    const n = this.data.length;
    return this.undirected ? n / 2 : n;
  }
  numVertices() {
    return this.m;
  }
  degree(id, type = "out") {
    let degree = 0;
    ensureIndex2(id, id, this.m, this.n);
    if (this.undirected || type !== "in") degree += this.nnzRow(id);
    if (!this.undirected && type !== "out") degree += this.nnzCol(id);
    return degree;
  }
  neighbors(id) {
    return this.nzRowCols(id);
  }
  invert() {
    return __invert(
      defAdjMatrix(this.m, void 0, this.undirected),
      this.edges()
    );
  }
  /**
   * Returns a diagonal sparse matrix
   * [`CSR`](https://docs.thi.ng/umbrella/sparse/classes/CSR.html) containing
   * information about the degree of each vertex, i.e. the number of edges
   * attached to each vertex.
   *
   * @remarks
   * Reference: https://en.wikipedia.org/wiki/Degree_matrix
   *
   * @param deg - degree type
   */
  degreeMat(deg = "out") {
    const res = CSR.empty(this.m);
    switch (deg) {
      case "out":
      default:
        for (let i = this.m; i-- > 0; ) {
          res.setAt(i, i, this.nnzRow(i));
        }
        break;
      case "in":
        for (let i = this.m; i-- > 0; ) {
          res.setAt(i, i, this.nnzCol(i));
        }
        break;
      case "inout":
        for (let i = this.m; i-- > 0; ) {
          res.setAt(i, i, this.nnzRow(i) + this.nnzCol(i));
        }
        break;
    }
    return res;
  }
  /**
   * Returns this graph's Laplacian matrix: `L = D - A` Where `D` is the
   * degree matrix and `A` this adjacency matrix.
   *
   * @remarks
   * References:
   *
   * - https://en.wikipedia.org/wiki/Laplacian_matrix
   * - https://en.wikipedia.org/wiki/Discrete_Laplace_operator
   *
   * @param deg - degree type for {@link AdjacencyMatrix.degreeMat}
   */
  laplacianMat(deg) {
    return (deg || this.degreeMat()).sub(this);
  }
  normalizedLaplacian(deg) {
    deg = deg || this.degreeMat();
    const m = this.m;
    const res = CSR.empty(m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j && deg.at(i, i) > 0) {
          res.setAt(i, j, 1);
        } else if (i !== j && this.at(i, j) > 0) {
          res.setAt(
            i,
            j,
            -1 / Math.sqrt(deg.at(i, i) * deg.at(j, j))
          );
        }
      }
    }
    return res;
  }
  /**
   * Computes: `I - nA + n^2 * (D - I)`, where `I` is the identity matrix,
   * `A` the adjacency matrix, `D` the degree matrix, and `n` is a
   * (complex-valued) number.
   *
   * @remarks
   * See {@link AdjacencyMatrix.degreeMat}.
   *
   * @param n - scale factor
   * @param deg - degree matrix
   */
  deformedLaplacian(n, deg) {
    deg = deg ? deg.copy() : this.degreeMat();
    const I = CSR.identity(this.m);
    return I.copy().sub(this.copy().mulN(n)).add(deg.sub(I).mulN(n * n));
  }
  toDot(ids) {
    return __toDot(this.edges(), this.undirected, ids);
  }
}
const defAdjMatrix = (n, edges, undirected = false) => {
  const raw = CSR.empty(n);
  const mat = new AdjacencyMatrix(
    n,
    raw.data,
    raw.rows,
    raw.cols,
    undirected
  );
  edges && __into(mat, edges);
  return mat;
};
export {
  AdjacencyMatrix,
  defAdjMatrix
};
