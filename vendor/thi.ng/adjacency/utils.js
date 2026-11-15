const __toDot = (edges, undirected, ids) => {
  const [type, sep] = undirected ? ["graph", "--"] : ["digraph", "->"];
  const res = [`${type} g {`];
  for (const e of edges) {
    res.push(
      ids ? `"${ids[e[0]]}"${sep}"${ids[e[1]]}";` : `"${e[0]}"${sep}"${e[1]}";`
    );
  }
  res.push(`}`);
  return res.join("\n");
};
const __into = (graph, edges) => {
  for (const e of edges) {
    graph.addEdge(e[0], e[1]);
  }
};
const __invert = (graph, edges) => {
  for (const e of edges) {
    graph.addEdge(e[1], e[0]);
  }
  return graph;
};
export {
  __into,
  __invert,
  __toDot
};
