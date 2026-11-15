import { BitField } from "@thi.ng/bitfield/bitfield";
import { DCons } from "@thi.ng/dcons/dcons";
class DFS {
  graph;
  marked;
  edges;
  src;
  constructor(graph, src) {
    this.graph = graph;
    this.src = src;
    const numV = graph.numVertices();
    this.edges = new Uint32Array(numV);
    this.marked = new BitField(numV);
    this.search(src);
  }
  search(id) {
    const { edges, marked } = this;
    marked.setAt(id);
    for (const n of this.graph.neighbors(id)) {
      if (!marked.at(n)) {
        edges[n] = id;
        this.search(n);
      }
    }
  }
  hasPathTo(id) {
    return this.marked.at(id) !== 0;
  }
  pathTo(id) {
    if (!this.marked.at(id)) return;
    const { edges, src } = this;
    const path = new DCons();
    for (; id !== src; id = edges[id]) {
      path.prepend(id);
    }
    path.prepend(id);
    return path;
  }
}
const dfs = (graph, src, dest) => new DFS(graph, src).pathTo(dest);
export {
  DFS,
  dfs
};
