const compress = (m, n, dense) => {
  const major = [0];
  const minor = [];
  const data = [];
  for (let i = 0, col = 0; col < n; col++) {
    let nnz = 0;
    for (let row = 0; row < m; i++, row++) {
      if (dense[i] !== 0) {
        data.push(dense[i]);
        minor.push(row);
        nnz++;
      }
    }
    major.push(major[major.length - 1] + nnz);
  }
  return [major, minor, data];
};
const diag = (vals) => {
  const n = vals.length;
  const major = [];
  const minor = [];
  for (let i = 0; i < n; i++) {
    major.push(i);
    minor.push(i);
  }
  major.push(n);
  return [major, minor];
};
const at = (id1, id2, major, minor, data) => {
  const ii = major[id1 + 1];
  for (let i = major[id1]; i < ii; i++) {
    if (minor[i] === id2) {
      return data[i];
    }
  }
  return 0;
};
const setAt = (id1, id2, id1max, val, major, minor, data, compact = true) => {
  const notZero = val !== 0;
  const ii = major[id1 + 1];
  for (let i = major[id1]; i < ii; i++) {
    const j = minor[i];
    if (j === id2) {
      if (notZero || !compact) {
        data[i] = val;
      } else {
        remove(id1, id1max, i, major, minor, data);
      }
      return [major, minor, data];
    } else if (j > id2 && notZero) {
      return insert(id1, id2, id1max, val, i, major, minor, data);
    }
  }
  if (notZero) {
    return insert(id1, id2, id1max, val, ii, major, minor, data);
  }
  return [major, minor, data];
};
const insert = (id1, id2, id1max, x, idx, major, minor, data) => {
  data = data.slice(0, idx).concat(x, data.slice(idx));
  minor = minor.slice(0, idx).concat(id2, minor.slice(idx));
  for (let i = id1 + 1; i <= id1max; i++) {
    major[i]++;
  }
  return [major, minor, data];
};
const remove = (id1, id1max, idx, major, minor, data) => {
  data.splice(idx, 1);
  minor.splice(idx, 1);
  for (let i = id1 + 1; i <= id1max; i++) {
    major[i]--;
  }
};
export {
  at,
  compress,
  diag,
  insert,
  remove,
  setAt
};
