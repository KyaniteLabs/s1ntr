import { isArrayLike } from "@thi.ng/checks/is-arraylike";
import { compare } from "@thi.ng/compare";
import { equiv } from "@thi.ng/equiv";
import { outOfBounds } from "@thi.ng/errors/out-of-bounds";
import {
  isReduced
} from "@thi.ng/transducers";
class AList {
  _head;
  _length = 0;
  constructor(src) {
    src && this.into(src);
  }
  get length() {
    return this._length;
  }
  get head() {
    return this._head;
  }
  [Symbol.iterator]() {
    return _iterate("next", this._head);
  }
  reverseIterator() {
    return _iterate("prev", this.tail);
  }
  clear() {
    this.release();
  }
  compare(o, cmp = compare) {
    let n = this._length;
    if (n < o._length) {
      return -1;
    } else if (n > o._length) {
      return 1;
    } else if (n === 0) {
      return 0;
    } else {
      let ca = this._head;
      let cb = o._head;
      let res = 0;
      for (; n-- > 0 && res === 0; ) {
        res = cmp(ca.value, cb.value);
        ca = ca.next;
        cb = cb.next;
      }
      return res;
    }
  }
  concat(...slices) {
    const res = this.copy();
    for (const slice of slices) {
      res.into(slice);
    }
    return res;
  }
  equiv(o) {
    if (!(o instanceof AList || isArrayLike(o)) || this._length !== o.length) {
      return false;
    }
    if (!this._length || this === o) return true;
    const iter = o[Symbol.iterator]();
    let cell = this._head;
    for (let n = this._length; n-- > 0; ) {
      if (!equiv(cell.value, iter.next().value)) {
        return false;
      }
      cell = cell.next;
    }
    return true;
  }
  filter(fn) {
    const res = this.empty();
    this.traverse((x) => (fn(x.value) && res.append(x.value), true));
    return res;
  }
  find(value) {
    return this.traverse((x) => x.value !== value);
  }
  findWith(fn) {
    return this.traverse((x) => !fn(x.value));
  }
  first() {
    return this._head?.value;
  }
  insertSorted(value, cmp) {
    cmp = cmp || compare;
    for (let cell = this._head, n = this._length; n-- > 0; ) {
      if (cmp(value, cell.value) <= 0) {
        return this.insertBefore(cell, value);
      }
      cell = cell.next;
    }
    return this.append(value);
  }
  into(src) {
    for (const x of src) {
      this.append(x);
    }
    return this;
  }
  nth(n, notFound) {
    const cell = this.nthCell(n);
    return cell ? cell.value : notFound;
  }
  nthCellUnsafe(n) {
    let cell;
    let dir;
    if (n <= this._length >>> 1) {
      cell = this._head;
      dir = "next";
    } else {
      cell = this.tail;
      dir = "prev";
      n = this._length - n - 1;
    }
    while (n-- > 0 && cell) {
      cell = cell[dir];
    }
    return cell;
  }
  peek() {
    return this.tail?.value;
  }
  /**
   * Implementation of
   * [IReducible.$reduce](https://docs.thi.ng/umbrella/transducers/interfaces/IReducible.html#_reduce._reduce-1)
   */
  $reduce(rfn, acc) {
    let cell = this._head;
    for (let n = this._length; n-- > 0 && !isReduced(acc); ) {
      acc = rfn(acc, cell.value);
      cell = cell.next;
    }
    return acc;
  }
  reduce(rfn, initial) {
    return this.$reduce(rfn, initial);
  }
  release() {
    let cell = this._head;
    if (!cell) return true;
    let next;
    for (let i = this._length; i-- > 0; ) {
      next = cell.next;
      delete cell.value;
      delete cell.prev;
      delete cell.next;
      cell = next;
    }
    this._head = void 0;
    this._length = 0;
    return true;
  }
  reverse() {
    let head = this._head;
    let tail = this.tail;
    let n = (this._length >>> 1) + (this._length & 1);
    while (head && tail && n > 0) {
      const t = head.value;
      head.value = tail.value;
      tail.value = t;
      head = head.next;
      tail = tail.prev;
      n--;
    }
    return this;
  }
  setHead(v) {
    const cell = this._head;
    if (cell) {
      cell.value = v;
      return cell;
    }
    return this.prepend(v);
  }
  setNth(n, v) {
    const cell = this.nthCell(n);
    !cell && outOfBounds(n);
    cell.value = v;
    return cell;
  }
  setTail(v) {
    const cell = this.tail;
    if (cell) {
      cell.value = v;
      return cell;
    }
    return this.append(v);
  }
  swap(a, b) {
    if (a !== b) {
      const t = a.value;
      a.value = b.value;
      b.value = t;
    }
    return this;
  }
  toArray(out = []) {
    this.traverse((x) => (out.push(x.value), true));
    return out;
  }
  toJSON() {
    return this.toArray();
  }
  toString() {
    let res = [];
    this.traverse((x) => (res.push(String(x.value)), true));
    return res.join(", ");
  }
  traverse(fn, start = this._head, end) {
    if (!this._head) return;
    let cell = start;
    do {
      if (!fn(cell)) break;
      cell = cell.next;
    } while (cell !== end);
    return cell;
  }
  _map(res, fn) {
    this.traverse((x) => (res.append(fn(x.value)), true));
    return res;
  }
}
function* _iterate(dir, cell) {
  while (cell) {
    yield cell.value;
    cell = cell[dir];
  }
}
export {
  AList
};
