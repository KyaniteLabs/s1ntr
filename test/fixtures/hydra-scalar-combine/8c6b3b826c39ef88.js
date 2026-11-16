shape(3, 0.40, 0.04)
  .rotate(()=> time*0.05 + Math.sin(time/7)*0.2)
  .scale(()=> 1.0 + Math.sin(time/6.5)*0.2)
  .color(()=> 0.55 + Math.sin(time/19)*0.08, ()=> 0.72 + Math.sin(time/23)*0.06, ()=> 0.95)
  .modulate(noise(2.1, 0.02), 0.025)
  .add(solid(0.018, 0.014, 0.035))
  .out(o1);

src(o0)
  .scale(()=> 0.997 + Math.sin(time/8.7)*0.0035)
  .rotate(()=> 0.0018 + Math.sin(time/13.3)*0.005)
  .modulate(noise(1.3, 0.012), ()=> 0.0025 + Math.sin(time/10.9)*0.0015)
  .color(()=> 0.998 + Math.sin(time/31)*0.002, ()=> 0.995 + Math.sin(time/37)*0.003, ()=> 1.0)
  .mult(()=> 0.992 + Math.sin(time/29.0)*0.004)
  .blend(o1, ()=> 0.055 + Math.sin(time/17.5)*0.012)
  .add(solid(0.004, 0.003, 0.009))
  .out(o0);