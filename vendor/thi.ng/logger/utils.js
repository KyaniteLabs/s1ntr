import { LogLevel } from "./api.js";
const expandArgs = (args) => args.map((x) => typeof x === "function" ? x() : x);
const expandArgsJSON = (args) => args.map((x) => {
  if (typeof x === "function") x = x();
  if (x instanceof Error) x = x.stack ?? x.message;
  if (x instanceof RegExp) x = x.source;
  if (!(typeof x === "string" || typeof x === "number")) {
    x = JSON.stringify(x);
  }
  return x;
});
const methodForLevel = (level) => (typeof level === "string" ? level : LogLevel[level]).toLowerCase();
export {
  expandArgs,
  expandArgsJSON,
  methodForLevel
};
