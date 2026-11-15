const balance = (pairs = {
  "(": ")",
  "{": "}",
  "[": "]"
}, symmetric = [`'`, `"`], skip = true) => {
  const open = /* @__PURE__ */ new Set();
  const close = /* @__PURE__ */ new Set();
  const $symmetric = new Set(symmetric);
  const invPair = {};
  for (const [k, v] of Object.entries(pairs)) {
    open.add(k);
    close.add(v);
    invPair[v] = k;
  }
  return (src) => {
    const stack = [];
    let scope;
    for (const c of src) {
      if (scope) {
        if (c === scope) scope = void 0;
      } else if ($symmetric.has(c)) {
        if (c === stack[stack.length - 1]) {
          stack.pop();
        } else {
          if (skip) scope = c;
          else stack.push(c);
        }
      } else if (open.has(c)) {
        stack.push(c);
      } else if (close.has(c) && stack.pop() !== invPair[c]) return false;
    }
    return !(stack.length || scope);
  };
};
export {
  balance
};
