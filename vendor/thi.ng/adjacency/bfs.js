import { BitField } from "@thi.ng/bitfield/bitfield";
import { DCons } from "@thi.ng/dcons/dcons";
class BFS {
  graph;
  marked;
  edges;
  dist;
  constructor(graph, src, cost = () => 1) {
    this.graph = graph;
    const numV = graph.numVertices();
    this.edges = new Uint32Array(numV);
    this.dist = new Float32Array(numV);
    this.marked = new BitField(numV);
    this.search(src, cost);
  }
  search(id, cost) {
    const queue = new DCons();
    queue.prepend(id);
    const { dist, edges, graph, marked } = this;
    dist.fill(4294967295);
    dist[id] = 0;
    marked.setAt(id);
    while (queue.length) {
      const v = queue.drop();
      for (const n of graph.neighbors(v)) {
        const c = dist[v] + cost(v, n);
        if (c < dist[n] || !marked.at(n)) {
          edges[n] = v;
          dist[n] = c;
          marked.setAt(n);
          queue.push(n);
        }
      }
    }
  }
  hasPathTo(id) {
    return this.marked.at(id) !== 0;
  }
  pathTo(id) {
    if (!this.marked.at(id)) return;
    const { dist, edges } = this;
    const path = new DCons();
    for (; dist[id] > 0; id = edges[id]) {
      path.prepend(id);
    }
    path.prepend(id);
    return path;
  }
}
const bfs = (graph, src, dest, cost) => new BFS(graph, src, cost).pathTo(dest);
export {
  BFS,
  bfs
};
