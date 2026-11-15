// clean-control p5 orbit
function setup() {
  createCanvas(400, 400);
}
function draw() {
  background(10, 12, 20);
  translate(width / 2, height / 2);
  const r = 80 + 20 * sin(frameCount * 0.02);
  fill(180, 220, 255);
  noStroke();
  ellipse(cos(frameCount * 0.03) * r, sin(frameCount * 0.03) * r, 12, 12);
}
