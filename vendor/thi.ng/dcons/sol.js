import { outOfBounds } from "@thi.ng/errors/out-of-bounds";
import { DCons } from "./dcons.js";
class SOL extends DCons {
  constructor(_reorder, src) {
    super();
    this._reorder = _reorder;
    src && this.into(src);
  }
  _reorder;
  copy() {
    return new SOL(this._reorder, this);
  }
  empty() {
    return new SOL(this._reorder);
  }
  find(value) {
    const cell = super.find(value);
    return cell ? this._reorder(this, cell) : void 0;
  }
  findWith(fn) {
    const cell = super.findWith(fn);
    return cell ? this._reorder(this, cell) : void 0;
  }
  nth(n, notFound) {
    const cell = super.nthCell(n);
    return cell ? this._reorder(this, cell).value : notFound;
  }
  setNth(n, v) {
    const cell = this.nthCell(n);
    !cell && outOfBounds(n);
    this._reorder(this, cell).value = v;
    return cell;
  }
  setTail(value) {
    const cell = this._tail;
    if (cell) {
      cell.value = value;
      this._reorder(this, cell);
      return cell;
    }
    return this.prepend(value);
  }
}
const defMTF = (src) => new SOL((list, cell) => (list.asHead(cell), cell), src);
const defTranspose = (src) => new SOL(
  (list, cell) => cell.prev ? (list.swap(cell.prev, cell), cell.prev) : cell,
  src
);
export {
  SOL,
  defMTF,
  defTranspose
};
