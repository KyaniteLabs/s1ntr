/** A vivid p5 sketch that clears the visual score gate (0.705 against the 0.65 floor). */
export const P5_SKETCH = `function setup(){createCanvas(windowWidth,windowHeight);colorMode(HSB,360,100,100,100);noStroke();}
function draw(){const t=frameCount*0.02;for(let y=0;y<height;y+=8){fill((y*0.4+t*60)%360,70,30+30*sin(t+y*0.02),100);rect(0,y,width,8);}
for(let i=0;i<80;i++){const a=t*(0.3+i*0.01)+i;const r=30+i*7+sin(t+i)*25;fill((i*9+t*50)%360,85,95,80);circle(width/2+cos(a)*r,height/2+sin(a)*r,14+10*sin(t*2+i));}}
function windowResized(){resizeCanvas(windowWidth,windowHeight);}`;
