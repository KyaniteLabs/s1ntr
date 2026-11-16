gradient(() => 0.65 + Math.sin(time * 0.017) * 0.12)
  .rotate(() => time * 0.008)
  .color(0.025, 0.13, 0.15)
  .blend(
    voronoi(() => 7.2 + Math.sin(time * 0.041) * 1.6, 0.32, () => 0.09 + Math.sin(time * 0.087) * 0.035)
      .rotate(() => time * 0.016)
      .scale(() => 1.06 + Math.sin(time * 0.029) * 0.08)
      .modulate(
        noise(() => 3.4 + Math.sin(time * 0.061) * 0.9, () => time * 0.024)
          .rotate(() => -time * 0.011)
          .scale(() => 1.15 + Math.sin(time * 0.037) * 0.12),
        () => 0.2 + Math.sin(time * 0.073) * 0.07
      )
      .modulate(
        voronoi(() => 13.5 + Math.sin(time * 0.119) * 3.2, 0.18, () => 0.16 + Math.sin(time * 0.143) * 0.06)
          .rotate(() => -time * 0.027)
          .scale(() => 0.94 + Math.sin(time * 0.053) * 0.06),
        () => 0.11 + Math.sin(time * 0.101) * 0.04
      )
      .color(
        () => 0.16 + Math.sin(time * 0.033) * 0.035,
        () => 0.31 + Math.sin(time * 0.047) * 0.05,
        () => 0.24 + Math.sin(time * 0.023) * 0.03
      )
      .add(
        noise(() => 10.5 + Math.sin(time * 0.157) * 2.2, () => -time * 0.036)
          .modulate(
            voronoi(() => 9 + Math.sin(time * 0.091) * 2, 0.25, () => 0.07 + Math.sin(time * 0.109) * 0.03),
            () => 0.16 + Math.sin(time * 0.067) * 0.05
          )
          .color(0.62, 0.58, 0.45)
          .mult(() => 0.075 + Math.sin(time * 0.131) * 0.025)
      )
      .blend(
        noise(() => 5.8 + Math.sin(time * 0.083) * 1.4, () => time * 0.018)
          .rotate(() => time * 0.013)
          .color(0.11, 0.25, 0.23)
          .mult(() => 0.28 + Math.sin(time * 0.059) * 0.08),
        () => 0.22 + Math.sin(time * 0.043) * 0.06
      ),
    () => 0.86 + Math.sin(time * 0.019) * 0.06
  )
  .out()