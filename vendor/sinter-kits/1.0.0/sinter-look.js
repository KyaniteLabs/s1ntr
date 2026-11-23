/* sinter-look 1.0.0 - own code (S1NTR). CRT / phosphor / film-grain overlay for any page.
 * Port of the launch-reel look (d10/look/look.py): 6% raster on every third line,
 * optical vignette (0.6 stop at the corners), zero-mean grain, optional phosphor tint.
 * It draws its own pointer-transparent canvas above the piece, so it works over p5,
 * three, html, custom and hydra without touching the piece's pixels or code. */
(function (root) {
  'use strict';
  // Seven phosphor hues 51.4 degrees apart in OKLCH (body / core); s1ntr is P7.
  var PHOSPHOR = {
    kai: { body: '#d42e9f', core: '#ffe1f2' }, claude: { body: '#f3572b', core: '#ffe3d9' },
    you: { body: '#b29cff', core: '#e6dcff' }, codex: { body: '#69dd3d', core: '#def2d9' },
    cursor: { body: '#44d6cf', core: '#cef4f1' }, hermes: { body: '#37abf4', core: '#d5efff' },
    s1ntr: { body: '#b29cff', core: '#e6dcff' }
  };
  function apply(opts) {
    opts = opts || {};
    var raster = opts.raster == null ? 0.06 : opts.raster;
    var vignette = opts.vignette == null ? 0.6 : opts.vignette;   // stops of falloff at the corners
    var grain = opts.grain == null ? 1 : opts.grain;
    var tint = opts.tint == null ? 0 : opts.tint;                 // 0..1 phosphor colour wash
    var ph = PHOSPHOR[opts.phosphor || 's1ntr'] || PHOSPHOR.s1ntr;
    var c = document.createElement('canvas');
    c.setAttribute('data-sinter-look', '');
    c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000';
    document.body.appendChild(c);
    var g = c.getContext('2d'), noise = document.createElement('canvas'), alive = true, raf = 0;
    noise.width = noise.height = 128;
    function size() { c.width = Math.max(1, innerWidth); c.height = Math.max(1, innerHeight); }
    function frame() {
      if (!alive) return;
      var w = c.width, h = c.height, i;
      g.clearRect(0, 0, w, h);
      if (tint > 0) { g.globalAlpha = 0.18 * tint; g.fillStyle = ph.body; g.globalCompositeOperation = 'soft-light'; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
      if (vignette > 0) {
        var r = Math.hypot(w, h) / 2, gr = g.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,' + (1 - Math.pow(2, -vignette)) + ')');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
      if (raster > 0) { g.fillStyle = 'rgba(0,0,0,' + raster + ')'; for (i = 2; i < h; i += 3) g.fillRect(0, i, w, 1); }
      if (grain > 0) {
        var n = noise.getContext('2d'), d = n.createImageData(128, 128), a = 255 * 0.07 * grain;
        for (i = 0; i < d.data.length; i += 4) { var v = Math.random() > 0.5 ? 255 : 0; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = Math.random() * a; }
        n.putImageData(d, 0, 0);
        g.fillStyle = g.createPattern(noise, 'repeat'); g.fillRect(0, 0, w, h);
      }
      raf = requestAnimationFrame(frame);
    }
    size(); addEventListener('resize', size); frame();
    return { canvas: c, destroy: function () { alive = false; cancelAnimationFrame(raf); removeEventListener('resize', size); c.remove(); } };
  }
  root.SinterLook = { PHOSPHOR: PHOSPHOR, apply: apply };
})(typeof window !== 'undefined' ? window : globalThis);
