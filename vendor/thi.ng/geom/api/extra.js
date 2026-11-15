class Extra {
  constructor(body) {
    this.body = body;
  }
  body;
  type = "extra";
  dim = 2;
  copy() {
    return new Extra(this.body);
  }
  withAttribs() {
    return this.copy();
  }
  toHiccup() {
    return this.body;
  }
}
export {
  Extra
};
