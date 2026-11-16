src(o0)
  .rotate(() => time * 0.037)
  .scale(() => 1.010 + Math.sin(time / 6.4) * 0.0035)
  .modulate(noise(3.4, () => time * 0.021), () => 0.0025 + Math.sin(time / 10.7) * 0.0012)
  .color(
    () => 0.86 + Math.sin(time / 8.3) * 0.07,
    () => 0.80 + Math.sin(time / 11.9) * 0.06,
    () => 0.92 + Math.sin(time / 7.1) * 0.06
  )
  .mult(() => 0.944 + Math.sin(time / 13.7) * 0.017)
  .add(
    shape(5, () => 0.105 + Math.sin(time / 2.8) * 0.016, 0.065)
      .rotate(() => -time * 0.17)
      .scale(() => 0.92 + Math.sin(time / 5.2) * 0.06)
      .color(
        () => 0.98 + Math.sin(time / 4.4) * 0.02,
        () => 0.70 + Math.sin(time / 6.6) * 0.09,
        () => 0.40 + Math.sin(time / 9.4) * 0.07
      )
      .mult(() => 0.065 + Math.sin(time / 8.9) * 0.012)
  )
  .blend(solid(0.018, 0.024, 0.038), () => 0.010 + Math.sin(time / 15.1) * 0.004)
  .out()