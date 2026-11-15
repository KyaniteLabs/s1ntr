import { __into, __invert, __toDot } from "./utils.js";
class AdjacencyList {
  adjacency = [];
  indegree = [];
  numE = 0;
  numV = 0;
  constructor(edges) {
    edges && __into(this, edges);
  }
  numEdges() {
    return this.numE;
  }
  numVertices() {
    return this.numV;
  }
  *vertices() {
    const { adjacency } = this;
    for (let i = 0, n = adjacency.length; i < n; i++) {
      if (adjacency[i]) yield i;
    }
  }
  *edges() {
    const { adjacency } = this;
    for (let i = 0, n = adjacency.length; i < n; i++) {
      const vertex = adjacency[i];
      if (!vertex) continue;
      for (const j of vertex) yield [i, j];
    }
  }
  addVertex(id) {
    this.ensureVertexData(id);
  }
  removeVertex(id) {
    const { adjacency, indegree } = this;
    const vertex = adjacency[id];
    if (!vertex) return false;
    while (vertex.length) {
      indegree[vertex.pop()]--;
      this.numE--;
    }
    delete adjacency[id];
    for (let i = 0, n = adjacency.length; i < n && indegree[id] > 0; i++) {
      const vertex2 = adjacency[i];
      if (!vertex2) continue;
      while (vertex2.includes(id)) this.removeEdge(i, id);
    }
    this.numV--;
    return true;
  }
  hasVertex(id) {
    return !!this.adjacency[id];
  }
  addEdge(from, to) {
    const vertex = this.ensureVertexData(from);
    this.ensureVertexData(to);
    vertex.push(to);
    this.indegree[to]++;
    this.numE++;
    return true;
  }
  removeEdge(from, to) {
    const vertex = this.adjacency[from];
    if (vertex) {
      const dest = vertex.indexOf(to);
      if (dest >= 0) {
        vertex.splice(dest, 1);
        this.numE--;
        this.indegree[to]--;
        return true;
      }
    }
    return false;
  }
  hasEdge(from, to) {
    const vertex = this.adjacency[from];
    return vertex ? vertex.includes(to) : false;
  }
  degree(id, type = "out") {
    let degree = 0;
    const vertex = this.adjacency[id];
    if (vertex) {
      if (type !== "in") degree += vertex.length;
      if (type !== "out") degree += this.indegree[id];
    }
    return degree;
  }
  neighbors(id) {
    return [...this.adjacency[id] || []];
  }
  invert() {
    return __invert(new AdjacencyList(), this.edges());
  }
  toDot(ids) {
    return __toDot(this.edges(), false, ids);
  }
  toString() {
    const { adjacency } = this;
    const res = [];
    for (let i = 0, n = adjacency.length; i < n; i++) {
      if (adjacency[i]) {
        res.push(
          `${i}: [${[...adjacency[i]].sort((a, b) => a - b).join(", ")}]`
        );
      }
    }
    return res.join("\n");
  }
  ensureVertexData(id) {
    const vertex = this.adjacency[id];
    if (vertex) return vertex;
    this.numV++;
    this.indegree[id] = 0;
    return this.adjacency[id] = [];
  }
}
const defAdjList = (edges) => new AdjacencyList(edges);
const adjListFromAdjacency = (src) => {
  const res = new AdjacencyList();
  for (let i = 0, n = src.length; i < n; i++) {
    const v = src[i];
    if (!v) continue;
    for (const w of v) res.addEdge(i, w);
  }
  return res;
};
export {
  AdjacencyList,
  adjListFromAdjacency,
  defAdjList
};
