src(o0)
  .rotate(() => time * 0.021)
  .scale(() => 1.003 + Math.sin(time / 6.7) * 0.0015)
  .modulate(
    noise(
      () => 1.7 + Math.sin(time / 11.0) * 0.4,
      () => 0.12 + Math.sin(time / 4.9) * 0.05
    )
      .rotate(() => -time * 0.013)
      .scale(() => 1.5 + Math.sin(time / 8.2) * 0.3),
    () => 0.018 + 0.012 * Math.sin(time / 3.3)
  )
  .modulate(
    gradient(() => time * 0.015)
      .rotate(() => -time * 0.009)
      .scale(() => 0.8 + Math.sin(time / 12.5) * 0.15),
    () => 0.012 + 0.006 * Math.cos(time / 5.5)
  )
  .color(
    () => 0.91 + 0.045 * Math.sin(time / 7.9),
    () => 0.86 + 0.055 * Math.sin(time / 10.3 + 2.1),
    () => 0.94 + 0.04 * Math.cos(time / 6.1)
  )
  .blend(
    shape(5, 0.085, 0.18)
      .rotate(() => time * 0.13)
      .scale(() => 0.92 + 0.22 * Math.sin(time / 2.7))
      .kaleid(7)
      .modulate(
        osc(
          () => 4 + Math.sin(time / 9.4) * 1.5,
          () => 0.08 + Math.sin(time / 3.9) * 0.03,
          () => 0.2 + Math.sin(time / 6.6) * 0.08
        )
          .rotate(() => -time * 0.05)
          .scale(() => 1.1 + Math.sin(time / 4.2) * 0.2),
        () => 0.08 + 0.04 * Math.sin(time / 5.3)
      )
      .color(
        () => 0.95 + 0.05 * Math.sin(time / 4.4),
        () => 0.78 + 0.08 * Math.sin(time / 8.8 + 1.1),
        () => 0.52 + 0.08 * Math.cos(time / 5.9)
      )
      .mult(() => 0.9 + 0.1 * Math.sin(time / 3.1)),
    () => 0.105 + 0.03 * Math.sin(time / 7.3)
  )
  .blend(
    voronoi(
      () => 2 + Math.sin(time / 13.0) * 0.5,
      () => 0.1 + Math.sin(time / 5.8) * 0.05,
      () => 0.3 + Math.cos(time / 9.0) * 0.1
    )
      .rotate(() => -time * 0.017)
      .scale(() => 1.2 + Math.sin(time / 10.2) * 0.2)
      .color(() => 0.15, () => 0.08, () => 0.12)
      .mult(() => 0.2 + 0.05 * Math.sin(time / 12.0)),
    () => 0.025 + 0.01 * Math.sin(time / 6.4)
  )
  .out()