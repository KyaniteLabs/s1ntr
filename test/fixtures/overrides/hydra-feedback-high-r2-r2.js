src(o0)
  .modulate(
    noise(1.35, 0.035).scale(1.25).rotate(() => time * 0.017),
    () => 0.007 + 0.009 * Math.sin(time / 9.3)
  )
  .scale(() => 1.0058 + 0.0038 * Math.sin(time / 13.7))
  .rotate(() => 0.0034 + 0.0026 * Math.sin(time / 17.9))
  .color(
    () => 0.982 + 0.010 * Math.sin(time / 23.1),
    () => 0.976 + 0.012 * Math.sin(time / 19.3),
    () => 0.970 + 0.014 * Math.sin(time / 29.7)
  )
  .blend(
    solid(0.030, 0.022, 0.058)
      .add(gradient(0.055).rotate(() => time * 0.0085).color(0.060, 0.040, 0.092))
      .add(voronoi(2.2, 0.35, 0.12).rotate(() => time * 0.013).color(0.032, 0.024, 0.050))
      .add(
        shape(3, 0.32, 0.38).kaleid(6)
          .rotate(() => time * 0.108)
          .scale(() => 1.06 + 0.26 * Math.sin(time / 8.3))
          .color(() => 0.80 + 0.10 * Math.sin(time / 19.1), 0.40, 0.185)
      )
      .add(
        shape(4, 0.085, 0.55)
          .rotate(() => -time * 0.29)
          .scale(() => 1.15 + 0.42 * Math.sin(time / 4.9))
          .color(0.26, 0.215, 0.165)
      ),
    () => 0.030 + 0.019 * Math.sin(time / 15.3)
  )
  .out()