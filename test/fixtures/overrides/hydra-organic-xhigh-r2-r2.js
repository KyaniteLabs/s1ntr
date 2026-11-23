voronoi(
  ()=>2.2 + Math.sin(time*0.055)*1.3,
  ()=>0.28 + Math.sin(time/8.5)*0.3,
  ()=>0.045 + time*0.008
)
.color(0.30,0.47,0.24)
.scale(()=>1.12 + Math.sin(time/21)*0.28)
.rotate(()=>Math.sin(time/37)*0.18)
.modulate(
  noise(()=>0.42 + Math.sin(time*0.031)*0.22, 0.6)
    .color(0.42,0.56,0.44)
    .scale(()=>1.7 + Math.sin(time/14)*0.5)
    .rotate(()=>time*0.013),
  ()=>0.42 + Math.sin(time/6.2)*0.22
)
.blend(
  noise(0.18,0.72)
    .color(0.08,0.22,0.22)
    .scale(()=>2.4 + Math.sin(time/29)*0.6)
    .rotate(()=>-time*0.006),
  ()=>0.40 + Math.sin(time/11)*0.15
)
.diff(
  voronoi(()=>3.1 + Math.sin(time/17)*0.9, 0.55, ()=>time*0.012)
    .color(0.16,0.30,0.20)
    .scale(()=>1.3 + Math.sin(time/25)*0.3)
    .rotate(()=>-time*0.009),
  ()=>0.22 + Math.sin(time/4.3)*0.12
)
.add(
  osc(()=>0.16 + Math.sin(time/19)*0.06, 0.12, 0.6)
    .color(0.78,0.76,0.64)
    .rotate(()=>time*0.021)
    .scale(()=>1.9 + Math.sin(time/13)*0.4),
  ()=>0.18 + Math.sin(time/9)*0.08
)
.mult(
  noise(0.09,0.5)
    .color(0.55,0.62,0.52)
    .scale(()=>1.05 + Math.sin(time/33)*0.15)
    .rotate(()=>time*0.004),
  0.55
)
.modulate(
  noise(0.12,0.4).color(0.5,0.58,0.5),
  ()=>0.18 + Math.sin(time/7)*0.1
)
.out()