import { BitMatrix } from "@thi.ng/bitfield/bitmatrix";
import { __into, __invert, __toDot } from "./utils.js";
class AdjacencyBitMatrix {
  mat;
  undirected;
  numE;
  constructor(n, edges, undirected = false) {
    this.mat = new BitMatrix(n);
    this.undirected = undirected;
    this.numE = 0;
    edges && __into(this, edges);
  }
  *edges() {
    const directed = !this.undirected;
    for (let i = this.mat.m; i-- > 0; ) {
      for (const n of this.neighbors(i)) {
        if (directed || n > i) {
          yield [i, n];
        }
      }
    }
  }
  numEdges() {
    return this.numE;
  }
  numVertices() {
    return this.mat.m;
  }
  /**
   * Resizes matrix to new size given.
   *
   * @param n - new max vertices
   */
  resize(n) {
    this.mat.resize(n);
    return this;
  }
  addEdge(from, to) {
    if (!this.mat.setAt(from, to, true)) {
      this.numE++;
      this.undirected && this.mat.setAt(to, from, true);
      return true;
    }
    return false;
  }
  removeEdge(from, to) {
    if (this.mat.setAt(from, to, false)) {
      this.numE--;
      this.undirected && this.mat.setAt(to, from, false);
      return true;
    }
    return false;
  }
  hasEdge(from, to) {
    return this.mat.at(from, to) !== 0;
  }
  hasVertex(id) {
    return this.mat.popCountRow(id) !== 0 || this.mat.popCountColumn(id) !== 0;
  }
  degree(id, type = "out") {
    let degree = 0;
    if (this.undirected || type !== "in")
      degree += this.mat.popCountRow(id);
    if (!this.undirected && type !== "out")
      degree += this.mat.popCountColumn(id);
    return degree;
  }
  neighbors(id) {
    return [...this.mat.row(id, true).positions()];
  }
  similarity(id, threshold = 0) {
    const mat = this.mat;
    const query = mat.row(id, true);
    const acc = [];
    for (let i = 0, m = mat.m; i < m; i++) {
      if (i === id) continue;
      const sim = query.similarity(mat.row(i, true));
      if (sim >= threshold) acc.push([i, sim]);
    }
    return acc.sort((a, b) => b[1] - a[1]);
  }
  invert() {
    return __invert(
      new AdjacencyBitMatrix(this.mat.n, void 0, this.undirected),
      this.edges()
    );
  }
  toString() {
    return this.mat.toString();
  }
  toDot(ids) {
    return __toDot(this.edges(), this.undirected, ids);
  }
}
const defAdjBitMatrix = (n, edges, undirected) => new AdjacencyBitMatrix(n, edges, undirected);
export {
  AdjacencyBitMatrix,
  defAdjBitMatrix
};
