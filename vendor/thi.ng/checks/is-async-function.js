const isAsyncFunction = (x) => x != null && Object.prototype.toString.call(x) === "[object AsyncFunction]";
export {
  isAsyncFunction
};
