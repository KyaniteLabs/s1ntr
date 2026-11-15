import { set } from "@thi.ng/vectors/set";
import { __copyAttribs } from "../internal/copy.js";
class Text {
  constructor(pos, body, attribs) {
    this.pos = pos;
    this.body = body;
    this.attribs = attribs;
  }
  pos;
  body;
  attribs;
  type = "text";
  dim = 2;
  copy() {
    return new Text(
      set([], this.pos),
      this.body,
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Text(this.pos, this.body, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.pos, this.body];
  }
}
export {
  Text
};
