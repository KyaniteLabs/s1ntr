import { illegalArity } from "@thi.ng/errors/illegal-arity";
import { range } from "./range.js";
function* range2d(...args) {
  let fromX, toX, stepX;
  let fromY, toY, stepY;
  switch (args.length) {
    case 6:
      stepX = args[4];
      stepY = args[5];
    case 4:
      [fromX, toX, fromY, toY] = args;
      break;
    case 2:
      [toX, toY] = args;
      fromX = fromY = 0;
      break;
    default:
      illegalArity(args.length);
  }
  const rx = range(fromX, toX, stepX);
  for (const y of range(fromY, toY, stepY)) {
    for (const x of rx) {
      yield [x, y];
    }
  }
}
export {
  range2d
};
