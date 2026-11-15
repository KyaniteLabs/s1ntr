// friction: subtle bug — undeclared identifier still partially "looks" like p5
function setup() {
  createCanvas(400, 400);
}
function draw() {
  background(12);
  // intentional defect: radius never defined; sketch throws after first frames
  ellipse(width / 2, height / 2, radius, radius);
}
