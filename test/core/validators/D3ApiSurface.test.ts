import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { HTMLValidator } from '../../../src/core/validators/HTMLValidator.js';
import { D3_EXPORTS } from '../../../src/core/validators/d3Api.generated.js';
import { d3BundlesLoaded, unknownD3Members } from '../../../src/core/validators/d3Api.js';

// A glm d9-dataviz piece (preflight 2026-11-16) passed validation and then
// threw "e is not a function" inside d3 at render: d3.interpolateOklch is not
// in d3 v7, so .interpolate(undefined) blows up when the scale first runs.
const page = (script: string, src = '/vendor/d3/7.9.0/d3.min.js') => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>t</title><script src="${src}"></script></head>
<body><svg></svg><script>${script}</script></body></html>`;

const d3Errors = (html: string) => HTMLValidator.validate(html).errors.filter((e) => e.startsWith('HTML d3:'));

describe('d3 API surface', () => {
  it('rejects the invented interpolator that broke the dataviz piece, and names real ones', () => {
    const errors = d3Errors(page('const c = d3.scaleLinear().range(["#000","#fff"]).interpolate(d3.interpolateOklch);'));
    expect(errors).toEqual([expect.stringContaining('d3.interpolateOklch')]);
    expect(errors[0]).toMatch(/d3\.interpolateHcl/);
  });

  it('accepts real d3 7.9 calls, add-on names included', () => {
    const code = 'd3.select("svg"); d3.scaleLinear().interpolate(d3.interpolateLab); d3.Delaunay.from([]); d3.geoPath(); d3.contours(); d3?.extent([1]);';
    expect(d3Errors(page(code))).toEqual([]);
  });

  it('reads the CDN tag the wrapper rewrites to the vendored copy', () => {
    expect(d3BundlesLoaded(page('', 'https://cdn.jsdelivr.net/npm/d3@7'))).toEqual(['d3']);
    expect(d3Errors(page('d3.interpolateOklch', 'https://cdn.jsdelivr.net/npm/d3@7'))).toHaveLength(1);
  });

  it('judges a page by the bundles it loads: d3-delaunay alone has no scales', () => {
    const html = page('d3.Delaunay.from([]); d3.scaleLinear();', '/vendor/d3-delaunay/6.0.4/d3-delaunay.min.js');
    expect(d3Errors(html)).toEqual([expect.stringContaining('d3.scaleLinear')]);
  });

  it('leaves alone pages without d3, a d3 the page binds, members the page adds, and computed reads', () => {
    expect(d3Errors(page('d3.nothing()', '/vendor/culori/4.0.2/culori.min.js'))).toEqual([]);
    expect(unknownD3Members('const d3 = { nope() {} }; d3.nope();', ['d3'])).toEqual([]);
    expect(unknownD3Members('d3.helper = () => 1; d3.helper();', ['d3'])).toEqual([]);
    expect(unknownD3Members('const k = "x"; d3[k];', ['d3'])).toEqual([]);
  });

  it('matches the vendored bundles byte for byte (rerun scripts/generate-d3-api.mjs on a bump)', () => {
    const sandbox: Record<string, unknown> = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.resolve('vendor/d3/7.9.0/d3.min.js'), 'utf8'), sandbox);
    expect(D3_EXPORTS.d3).toEqual(Object.keys(sandbox.d3 as object).sort());
  });
});
