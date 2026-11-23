const breath = () => 0.5 + 0.5 * Math.sin(time / 8.2)
const mid    = () => 0.5 + 0.5 * Math.sin(time / 3.4 + 0.9)
const rapid  = () => 0.5 + 0.5 * Math.sin(time * 1.9 + 2.1)

// the tunnel: its own history, scaled and rotated inward
const memory = src(o0)
  .scale(() => 1.030 + Math.sin(time / 12.5) * 0.010)
  .rotate(() => 0.005 + Math.sin(time / 21) * 0.007)
  .modulate(noise(0.31, 0.05).scale(2.2), () => 0.012 + mid() * 0.018)
  .color(() => 0.84 + breath() * 0.12, () => 0.79 + mid() * 0.11, () => 0.89 + breath() * 0.11)
  .saturate(() => 1.06 + mid() * 0.32)
  .contrast(() => 1.02 + breath() * 0.11)

// slow lattice of veins that the spiral drags inward
const bloom = voronoi(2.4, 0.82, 0.18)
  .scale(1.5)
  .rotate(() => time * 0.045)
  .kaleid(4)
  .color(1.0, 0.42, 1.15)
  .mult(solid(() => 0.10 + mid() * 0.12, () => 0.06 + rapid() * 0.10, () => 0.14 + breath() * 0.12))

// the one bright seed that keeps the loop alive
const seed = shape(3, () => 0.16 + rapid() * 0.05, 0.42)
  .scale(() => 1.9 + Math.sin(time / 6.1) * 0.4)
  .rotate(() => time * 0.23 + Math.sin(time / 4.3) * 0.2)
  .modulate(osc(7, 0.09, 1.4).scale(1.7), 0.32)
  .color(() => 1.15 + breath() * 0.45, () => 0.28 + mid() * 0.22, () => 0.92 + rapid() * 0.35)

seed
  .add(memory)
  .add(bloom)
  .mult(solid(() => 0.93 + breath() * 0.07, () => 0.89 + mid() * 0.09, () => 0.95 + breath() * 0.06))
  .colorama(() => 0.012 + breath() * 0.018)
  .contrast(() => 1.05 + breath() * 0.14)
  .saturate(() => 1.1 + mid() * 0.2)
  .out()