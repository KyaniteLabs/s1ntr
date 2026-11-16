src(o0)
  .rotate(() => time * 0.027 + Math.sin(time / 9.0) * 0.075)
  .scale(() => 1.006 + Math.sin(time / 6.5) * 0.004)
  .kaleid(6)
  .modulate(
    noise(() => 0.72 + Math.sin(time / 12.0) * 0.12, 0.08),
    () => 0.018 + Math.sin(time / 7.3) * 0.012
  )
  .mult(() => 0.89 + Math.sin(time / 4.1) * 0.045)
  .blend(
    shape(4, 0.30, 0.55)
      .rotate(() => -time * 0.16)
      .scale(() => 0.78 + Math.sin(time / 3.3) * 0.11)
      .color(
        () => 1.05 + Math.sin(time / 2.6) * 0.12,
        () => 0.60 + Math.sin(time / 3.9) * 0.10,
        () => 0.26 + Math.sin(time / 5.2) * 0.08
      ),
    () => 0.085 + Math.sin(time / 8.7) * 0.018
  )
  .out()