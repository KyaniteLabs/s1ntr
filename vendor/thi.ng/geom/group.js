import { Group } from "./api/group.js";
const group = (attribs = {}, children) => new Group(attribs, children);
export {
  group
};
