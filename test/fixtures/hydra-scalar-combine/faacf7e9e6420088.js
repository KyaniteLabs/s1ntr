src(o0)
  .rotate(() => time * 0.018)
  .scale(() => 0.999 + Math.sin(time / 7) * 0.0006)
  .kaleid(6)
  .modulate(
    voronoi(5, 0.18, 0.56)
      .rotate(() => -time * 0.031)
      .scale(() => 1.3 + Math.sin(time / 12) * 0.25),
    () => 0.05 + Math.sin(time / 4) * 0.018
  )
  .modulate(
    osc(18, 0.03, 0.35)
      .rotate(() => time * 0.047),
    () => 0.008 + Math.sin(time / 2.5) * 0.004
  )
  .color(
    () => 0.975 + Math.sin(time / 11) * 0.015,
    () => 0.98 + Math.sin(time / 13) * 0.012,
    () => 0.985 + Math.sin(time / 17) * 0.01
  )
  .mult(() => 0.99 + Math.sin(time / 19) * 0.006)
  .blend(
    src(o0)
      .rotate(() => -time * 0.012)
      .scale(() => 0.998 + Math.sin(time / 9) * 0.0006)
      .repeat(2, 2)
      .color(1.2, 0.06, 0.35)
      .mult(() => 0.35 + Math.sin(time / 15) * 0.05),
    () => 0.014 + Math.sin(time / 4.5) * 0.004
  )
  .blend(
    shape(6, 0.09, 0.14)
      .rotate(() => time * 0.11)
      .scale(() => 0.9 + Math.sin(time / 5) * 0.12)
      .color(1.5, 0.9, 0.32),
    () => 0.009 + Math.sin(time / 6) * 0.003
  )
  .out()