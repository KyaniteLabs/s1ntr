src(o0)
  .scale(()=>1.008 + 0.003*Math.sin(time*0.11))
  .rotate(()=>0.0034 + 0.0022*Math.sin(time*0.073))
  .modulate(noise(0.09,0.035).scale(2.4), ()=>0.012 + 0.007*Math.sin(time*0.051))
  .modulate(noise(0.022,0.11).scale(0.7), 0.006)
  .mult(solid(
      ()=>0.9860 + 0.0022*Math.sin(time*0.037),
      ()=>0.9810 + 0.0022*Math.sin(time*0.037 + 0.7),
      ()=>0.9740 + 0.0022*Math.sin(time*0.037 + 1.4)
  ))
  .add(
      shape(4, 0.22, 0.22)
        .modulate(noise(0.065,0.028).scale(1.6), 0.18)
        .rotate(()=>time*0.21)
        .scale(()=>1.02 + 0.14*Math.sin(time*0.19))
        .color(
          ()=>0.0105 + 0.0028*Math.sin(time*0.13),
          ()=>0.0100 + 0.0028*Math.sin(time*0.083 + 1.1),
          ()=>0.0095 + 0.0028*Math.sin(time*0.047 + 2.4)
        ),
      0.9
  )
  .add(voronoi(1.2, 0.07).scale(1.3).kaleid(5).color(0.0018, 0.0024, 0.0045), 0.5)
  .out()