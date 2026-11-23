/**
 * Mpeg4Mosh - a real bitstream edit of an MPEG-4 part 2 elementary stream (.m4v).
 *
 * Datamosh is a codec artifact, not a filter: delete the I-VOPs (the frames that carry a full
 * picture) and the decoder keeps applying the next P-VOPs' motion vectors to whatever picture it
 * already holds; repeat a P-VOP and its motion is applied again and again. This module splits the
 * stream at VOP start codes (00 00 01 B6), classifies each VOP by its coding type and rebuilds the
 * stream without or with extra copies. A GOV header (00 00 01 B3) belongs to the I-VOP after it.
 */
export type VopType = 'I' | 'P' | 'B' | 'S';
export interface Vop { type: VopType; start: number; end: number }
export interface MoshEdit {
  /** 'all' strips every I-VOP after the first; a list strips those VOP indexes (the first I-VOP is always kept). */
  strip: 'all' | number[];
  holds: Array<{ at: number; repeat: number }>;
}
export interface MoshStats { iBefore: number; pBefore: number; iAfter: number; pAfter: number; stripped: number; duplicated: number }

export const MAX_HOLD_REPEAT = 120;
const TYPES: VopType[] = ['I', 'P', 'B', 'S'];

export function splitMpeg4(buf: Buffer): { header: Buffer; vops: Vop[] } {
  const marks: number[] = [];
  for (let i = buf.indexOf(Buffer.from([0, 0, 1, 0xb6])); i >= 0; i = buf.indexOf(Buffer.from([0, 0, 1, 0xb6]), i + 4)) marks.push(i);
  if (marks.length === 0) throw new Error('mpeg4 stream has no VOP start code');
  // A GOV start code between two VOPs begins the next VOP's chunk.
  const starts = marks.map((mark, index) => {
    const floor = index === 0 ? 0 : marks[index - 1] + 4;
    const gov = buf.subarray(floor, mark).lastIndexOf(Buffer.from([0, 0, 1, 0xb3]));
    return gov >= 0 ? floor + gov : mark;
  });
  const vops: Vop[] = marks.map((mark, index) => ({
    type: TYPES[(buf[mark + 4] >> 6) & 3],
    start: starts[index],
    end: index + 1 < marks.length ? starts[index + 1] : buf.length,
  }));
  return { header: buf.subarray(0, starts[0]), vops };
}

export function moshMpeg4(buf: Buffer, edit: MoshEdit, maxBytes = Number.POSITIVE_INFINITY): { out: Buffer; stats: MoshStats } {
  const { header, vops } = splitMpeg4(buf);
  const holdAt = new Map<number, number>();
  for (const hold of edit.holds) {
    if (!Number.isInteger(hold.at) || hold.at < 0 || hold.at >= vops.length) throw new Error(`hold index ${hold.at} is out of range 0..${vops.length - 1}`);
    if (vops[hold.at].type !== 'P') throw new Error(`hold index ${hold.at} is a ${vops[hold.at].type}-VOP; only a P-VOP can be repeated`);
    if (!Number.isInteger(hold.repeat) || hold.repeat < 1 || hold.repeat > MAX_HOLD_REPEAT) throw new Error(`hold repeat must be 1..${MAX_HOLD_REPEAT}`);
    holdAt.set(hold.at, (holdAt.get(hold.at) ?? 0) + hold.repeat);
  }
  const stripSet = new Set(edit.strip === 'all' ? vops.map((v, i) => (v.type === 'I' ? i : -1)).filter((i) => i > 0) : edit.strip.filter((i) => i > 0));
  const parts: Buffer[] = [header];
  let outputBytes = header.length;
  if (outputBytes > maxBytes) throw new Error('bitstream expansion exceeds the byte limit');
  const stats: MoshStats = { iBefore: 0, pBefore: 0, iAfter: 0, pAfter: 0, stripped: 0, duplicated: 0 };
  vops.forEach((vop, index) => {
    if (vop.type === 'I') stats.iBefore += 1;
    if (vop.type === 'P') stats.pBefore += 1;
    if (stripSet.has(index) && vop.type === 'I') { stats.stripped += 1; return; }
    const bytes = buf.subarray(vop.start, vop.end);
    // Repeats carry the bare VOP: a GOV header is only legal once per group.
    const repeats = holdAt.get(index) ?? 0;
    outputBytes += bytes.length * (repeats + 1);
    if (outputBytes > maxBytes) throw new Error('bitstream expansion exceeds the byte limit');
    parts.push(bytes);
    if (vop.type === 'I') stats.iAfter += 1;
    if (vop.type === 'P') stats.pAfter += 1;
    for (let n = 0; n < repeats; n += 1) parts.push(bytes);
    stats.duplicated += repeats;
  });
  // duplicated P-VOPs are P frames in the output too
  stats.pAfter += stats.duplicated;
  return { out: Buffer.concat(parts, outputBytes), stats };
}
