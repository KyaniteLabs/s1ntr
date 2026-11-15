const jaccardSimilarity = ({ data: adata }, { data: bdata }) => {
  const an = adata.length;
  const bn = bdata.length;
  let numIsec = 0;
  for (let i = 0, j = 0; i < an && j < bn; ) {
    const apos = adata[i];
    const bpos = bdata[j];
    if (apos === bpos) {
      numIsec++;
      i += 2;
      j += 2;
    } else if (apos < bpos) {
      i += 2;
    } else {
      j += 2;
    }
  }
  const numUnion = (an + bn >>> 1) - numIsec;
  return numUnion > 0 ? numIsec / numUnion : 0;
};
const cosineSimilarity = (a, b) => {
  const dot = a.dot(b);
  return dot ? dot / (a.mag() * b.mag()) : 0;
};
export {
  cosineSimilarity,
  jaccardSimilarity
};
