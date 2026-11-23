import { describe, expect, it } from 'vitest';
import { moshMpeg4, splitMpeg4 } from '../../../src/render/Mpeg4Mosh.js';

const VOP = (type: 0 | 1, tag: number, gov = false) => Buffer.concat([
  gov ? Buffer.from([0, 0, 1, 0xb3, 0x00, 0x00, 0x08]) : Buffer.alloc(0),
  Buffer.from([0, 0, 1, 0xb6, (type << 6) | 0x10, tag, 0xaa, 0xbb]),
]);
const HEADER = Buffer.from([0, 0, 1, 0x00, 0, 0, 1, 0x20, 0x11, 0x22]);
/** I P P I P P I P  */
const STREAM = Buffer.concat([HEADER, VOP(0, 1), VOP(1, 2), VOP(1, 3), VOP(0, 4, true), VOP(1, 5), VOP(1, 6), VOP(0, 7, true), VOP(1, 8)]);

describe('splitMpeg4', () => {
  it('finds the header and every VOP with its coding type', () => {
    const { header, vops } = splitMpeg4(STREAM);
    expect(header.equals(HEADER)).toBe(true);
    expect(vops.map((v) => v.type)).toEqual(['I', 'P', 'P', 'I', 'P', 'P', 'I', 'P']);
  });
  it('attaches a GOV header to the I-VOP that follows it, not the previous frame', () => {
    const { vops } = splitMpeg4(STREAM);
    expect(STREAM.subarray(vops[3].start, vops[3].start + 4).equals(Buffer.from([0, 0, 1, 0xb3]))).toBe(true);
  });
  it('throws on a stream with no VOP', () => {
    expect(() => splitMpeg4(Buffer.from([1, 2, 3]))).toThrow(/VOP/);
  });
});

describe('moshMpeg4', () => {
  it('strips every I-VOP after the first and reports the counts', () => {
    const { out, stats } = moshMpeg4(STREAM, { strip: 'all', holds: [] });
    const after = splitMpeg4(out);
    expect(after.vops.map((v) => v.type)).toEqual(['I', 'P', 'P', 'P', 'P', 'P']);
    expect(stats).toMatchObject({ iBefore: 3, pBefore: 5, iAfter: 1, pAfter: 5, stripped: 2, duplicated: 0 });
  });
  it('never strips the first I-VOP even if asked', () => {
    const { out } = moshMpeg4(STREAM, { strip: [0, 3], holds: [] });
    expect(splitMpeg4(out).vops.map((v) => v.type)).toEqual(['I', 'P', 'P', 'P', 'P', 'I', 'P']);
  });
  it('repeats a P-VOP byte-for-byte', () => {
    const { out, stats } = moshMpeg4(STREAM, { strip: [], holds: [{ at: 2, repeat: 3 }] });
    const { vops } = splitMpeg4(out);
    expect(vops).toHaveLength(8 + 3);
    const bytes = (i: number) => out.subarray(vops[i].start, vops[i].end);
    expect(bytes(3).equals(bytes(2))).toBe(true);
    expect(bytes(5).equals(bytes(2))).toBe(true);
    expect(stats.duplicated).toBe(3);
  });
  it('refuses to repeat an I-VOP, an out-of-range index, or an absurd count', () => {
    expect(() => moshMpeg4(STREAM, { strip: [], holds: [{ at: 0, repeat: 2 }] })).toThrow(/P-VOP/);
    expect(() => moshMpeg4(STREAM, { strip: [], holds: [{ at: 99, repeat: 2 }] })).toThrow(/range/);
    expect(() => moshMpeg4(STREAM, { strip: [], holds: [{ at: 1, repeat: 5000 }] })).toThrow(/repeat/);
  });
  it('caps the combined size of repeated holds before allocating the output', () => {
    const edit = { strip: [] as number[], holds: [{ at: 2, repeat: 3 }, { at: 2, repeat: 4 }] };
    const { out } = moshMpeg4(STREAM, edit);
    expect(moshMpeg4(STREAM, edit, out.length).out).toEqual(out);
    expect(() => moshMpeg4(STREAM, edit, out.length - 1)).toThrow(/expansion exceeds the byte limit/);
  });
});
