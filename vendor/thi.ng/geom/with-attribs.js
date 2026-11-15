const withAttribs = (shape, attribs = {}, replace = true) => shape.withAttribs(replace ? attribs : { ...shape.attribs, ...attribs });
export {
  withAttribs
};
