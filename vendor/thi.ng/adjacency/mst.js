import { sortByCachedKey } from "@thi.ng/arrays/sort-cached";
import { DisjointSet } from "@thi.ng/disjoint-set";
const mst = (edges, maxID, cost, verts) => {
  const graph = new DisjointSet(maxID + 1);
  const res = [];
  for (const e of sortByCachedKey(edges, cost)) {
    const v = verts(e);
    if (!graph.unified(v[0], v[1])) {
      graph.union(v[0], v[1]);
      res.push(e);
    }
  }
  return res;
};
export {
  mst
};
