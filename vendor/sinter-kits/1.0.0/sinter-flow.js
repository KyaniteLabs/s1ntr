/* sinter-flow 1.0.0 - own code (S1NTR). Seeded noise, curl fields and a canvas-2D flow-particle
 * system. No dependency: pass any CanvasRenderingContext2D (p5: drawingContext). */
(function (root) {
  'use strict';
  var perm = new Uint8Array(512);
  function seed(s) {
    var p = [], i, x = (s >>> 0) || 1;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; var j = x % (i + 1), t = p[i]; p[i] = p[j]; p[j] = t; }
    for (i = 0; i < 512; i++) perm[i] = p[i & 255];
  }
  seed(1337);
  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function grad(h, x, y, z) { h &= 15; var u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z); return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); }
  /** Perlin noise in [0,1]. */
  function noise3(x, y, z) {
    var X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    var u = fade(x), v = fade(y), w = fade(z), A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z, B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    var r = lerp(lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
                 lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u), lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v), w);
    return (r + 1) / 2;
  }
  function noise2(x, y) { return noise3(x, y, 0); }
  /** Divergence-free [vx, vy] from the noise potential: swirls that never converge. */
  function curl(x, y, t) {
    var e = 0.01, dx = noise3(x, y + e, t) - noise3(x, y - e, t), dy = noise3(x + e, y, t) - noise3(x - e, y, t);
    return [dx / (2 * e), -dy / (2 * e)];
  }
  /** Flow angle at a point, in radians. */
  function angle(x, y, t, scale) { return noise3(x * (scale || 0.005), y * (scale || 0.005), t || 0) * Math.PI * 4; }
  function Flow(w, h, o) {
    o = o || {}; this.w = w; this.h = h; this.scale = o.scale || 0.004; this.speed = o.speed || 1.4; this.t = 0; this.mode = o.mode || 'angle';
    this.p = []; for (var i = 0; i < (o.count || 600); i++) this.p.push({ x: Math.random() * w, y: Math.random() * h, px: 0, py: 0 });
  }
  /** Advance one frame and draw short strokes (ctx.strokeStyle/lineWidth are yours). */
  Flow.prototype.step = function (ctx, dt) {
    this.t += (dt == null ? 0.004 : dt);
    ctx.beginPath();
    for (var i = 0; i < this.p.length; i++) {
      var q = this.p[i], vx, vy;
      if (this.mode === 'curl') { var c = curl(q.x * this.scale, q.y * this.scale, this.t); vx = c[0]; vy = c[1]; var m = Math.hypot(vx, vy) || 1; vx /= m; vy /= m; }
      else { var a = angle(q.x, q.y, this.t, this.scale); vx = Math.cos(a); vy = Math.sin(a); }
      q.px = q.x; q.py = q.y; q.x += vx * this.speed; q.y += vy * this.speed;
      if (q.x < 0 || q.x > this.w || q.y < 0 || q.y > this.h) { q.x = Math.random() * this.w; q.y = Math.random() * this.h; q.px = q.x; q.py = q.y; }
      ctx.moveTo(q.px, q.py); ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
  };
  root.SinterFlow = { seed: seed, noise2: noise2, noise3: noise3, curl: curl, angle: angle, Flow: Flow };
})(typeof window !== 'undefined' ? window : globalThis);
