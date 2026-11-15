import { AList } from "./alist.js";
class DRing extends AList {
  constructor(src) {
    super();
    src && this.into(src);
  }
  get tail() {
    return this._head ? this._head.prev : void 0;
  }
  append(value) {
    if (!this._head) return this.prepend(value);
    const prev = this._head.prev;
    const cell = {
      value,
      prev,
      next: this._head
    };
    prev.next = cell;
    this._head.prev = cell;
    this._length++;
    return cell;
  }
  copy() {
    return new DRing(this);
  }
  drop() {
    if (this._head) {
      const res = this._head.value;
      this.remove(this._head);
      return res;
    }
  }
  empty() {
    return new DRing();
  }
  insertBefore(cell, value) {
    const newCell = { value, prev: cell.prev, next: cell };
    cell.prev.next = newCell;
    cell.prev = newCell;
    if (cell === this._head) {
      this._head = newCell;
    }
    this._length++;
    return newCell;
  }
  insertAfter(cell, value) {
    const newCell = { value, prev: cell, next: cell.next };
    cell.next.prev = newCell;
    cell.next = newCell;
    this._length++;
    return newCell;
  }
  map(fn) {
    return this._map(new DRing(), fn);
  }
  nth(n, notFound) {
    const cell = this.nthCell(n);
    return cell ? cell.value : notFound;
  }
  nthCell(n) {
    const len = this._length;
    return len ? this.nthCellUnsafe(n - Math.floor(n / len) * len) : void 0;
  }
  prepend(value) {
    let cell;
    if (this._head) {
      const tail = this.tail;
      cell = { value, prev: tail, next: this._head };
      tail.next = cell;
      this._head.prev = cell;
      this._head = cell;
    } else {
      cell = { value };
      cell.prev = cell;
      cell.next = cell;
      this._head = cell;
    }
    this._length++;
    return cell;
  }
  remove(v) {
    if (this._head === v) {
      if (this._length === 1) {
        this._head = void 0;
        this._length = 0;
        return;
      }
      this._head = v.next;
    }
    v.prev.next = v.next;
    v.next.prev = v.prev;
    this._length--;
  }
  rotateLeft() {
    this._head && (this._head = this._head.next);
    return this;
  }
  rotateRight() {
    this._head && (this._head = this._head.prev);
    return this;
  }
  /**
   * Implementation of
   * [ISeqable.seq](https://docs.thi.ng/umbrella/api/interfaces/ISeqable.html#seq.seq-1)
   */
  seq() {
    const $seq = (cell) => ({
      first() {
        return cell.value;
      },
      next() {
        return $seq(cell.next);
      }
    });
    return this._head ? $seq(this._head) : void 0;
  }
  traverse(fn, start = this._head, end = start) {
    return super.traverse(fn, start, end);
  }
}
const defDRing = (src) => new DRing(src);
export {
  DRing,
  defDRing
};
