solid(0.012, 0.055, 0.058)
  .blend(
    noise(2.6, () => time * 0.021)
      .scale(() => 1.25 + Math.sin(time / 17) * 0.16)
      .rotate(() => time * 0.006)
      .modulate(
        voronoi(
          () => 10 + Math.sin(time / 13) * 3,
          () => 0.38 + Math.sin(time / 9) * 0.07,
          () => 0.72 + Math.sin(time / 29) * 0.1
        ),
        () => 0.32 + Math.sin(time / 11) * 0.08
      )
      .color(0.08, 0.26, 0.23)
      .add(() => 0.012 + Math.sin(time / 23) * 0.006),
    () => 0.78
  )
  .blend(
    voronoi(
      () => 15 + Math.sin(time / 12) * 4,
      () => 0.18 + Math.sin(time / 7) * 0.06,
      () => 0.7 + Math.sin(time / 19) * 0.12
    )
      .rotate(() => -time * 0.014)
      .scale(() => 1.05 + Math.sin(time / 21) * 0.12)
      .modulate(
        noise(4.2, () => time * 0.047)
          .scale(() => 0.85 + Math.sin(time / 8) * 0.12),
        () => 0.28 + Math.sin(time / 6) * 0.09
      )
      .color(0.36, 0.48, 0.31)
      .mult(() => 0.72 + Math.sin(time / 15) * 0.12),
    () => 0.62
  )
  .blend(
    shape(4, () => 0.24 + Math.sin(time / 26) * 0.05, 0.22)
      .repeat(
        () => 16 + Math.sin(time / 37) * 2,
        () => 16 + Math.sin(time / 31 + 1.7) * 2
      )
      .rotate(() => time * 0.003)
      .modulate(
        noise(7.5, () => time * 0.06)
          .scale(() => 1.4 + Math.sin(time / 10) * 0.18),
        () => 0.2 + Math.sin(time / 5) * 0.06
      )
      .color(0.66, 0.63, 0.49)
      .mult(() => 0.22 + Math.sin(time / 33) * 0.07),
    () => 0.28
  )
  .blend(
    gradient(() => 0.6 + Math.sin(time / 43) * 0.08)
      .rotate(() => time * 0.004)
      .scale(() => 0.9 + Math.sin(time / 27) * 0.08)
      .color(0.03, 0.13, 0.15)
      .mult(() => 0.4 + Math.sin(time / 35) * 0.1),
    () => 0.24
  )
  .out()