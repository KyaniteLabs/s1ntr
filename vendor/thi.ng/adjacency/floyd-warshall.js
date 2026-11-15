import { outOfBounds } from "@thi.ng/errors/out-of-bounds";
class FloydWarshall {
  dist;
  next;
  numV;
  /**
   * Instantiates and pre-computes all shortest paths in given `graph`. See
   * class comments for details.
   *
   * @param graph
   * @param cost
   */
  constructor(graph, cost = () => 1) {
    const numV = this.numV = graph.numVertices();
    const dist = this.dist = new Float32Array(numV * numV).fill(Infinity);
    const next = this.next = new Int32Array(numV * numV).fill(-1);
    for (const [u, v] of graph.edges()) {
      const idx = u * numV + v;
      dist[idx] = cost(u, v);
      next[idx] = v;
    }
    for (let v = 0; v < numV; v++) {
      const idx = v * numV + v;
      dist[idx] = 0;
      next[idx] = v;
    }
    for (let k = 0; k < numV; k++) {
      for (let i = 0; i < numV; i++) {
        const idxIK = i * numV + k;
        for (let j = 0; j < numV; j++) {
          const idxIJ = i * numV + j;
          const idxKJ = k * numV + j;
          const minD = dist[idxIK] + dist[idxKJ];
          if (dist[idxIJ] > minD) {
            dist[idxIJ] = minD;
            next[idxIJ] = next[idxIK];
          }
        }
      }
    }
  }
  /**
   * Returns shortest distance between vertices `a` and `b`, or `undefined` if
   * no connecting path exists. Throws an error if either `a` or `b` are out
   * of bounds.
   *
   * @param a
   * @param b
   */
  distance(a, b) {
    this.ensurePair(a, b);
    return this.dist[a * this.numV + b];
  }
  /**
   * Returns iterator of vertex IDs of path between `a` and `b` (if any).
   * Throws an error if either `a` or `b` are out of bounds.
   *
   * @param a
   * @param b
   */
  *path(a, b) {
    this.ensurePair(a, b);
    const { next, numV } = this;
    if (next[a * numV + b] === -1) return;
    yield a;
    while (a !== b) {
      a = next[a * numV + b];
      yield a;
    }
  }
  ensureIndex(id) {
    !(id >= 0 && id < this.numV) && outOfBounds(id);
  }
  ensurePair(a, b) {
    this.ensureIndex(a);
    this.ensureIndex(b);
  }
}
const floydWarshall = (graph, cost) => new FloydWarshall(graph, cost);
export {
  FloydWarshall,
  floydWarshall
};
