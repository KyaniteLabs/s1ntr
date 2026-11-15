import {
  shearX22,
  shearX23,
  shearXY33,
  shearXY44,
  shearXZ33,
  shearXZ44,
  shearY22,
  shearY23,
  shearYX33,
  shearYX44,
  shearYZ33,
  shearYZ44,
  shearZX33,
  shearZX44,
  shearZY33,
  shearZY44
} from "./shear.js";
const $ = (f) => (m, theta) => f(m, Math.tan(theta));
const skewX22 = $(shearX22);
const skewY22 = $(shearY22);
const skewX23 = $(shearX23);
const skewY23 = $(shearY23);
const skewXY33 = $(shearXY33);
const skewXZ33 = $(shearXZ33);
const skewYX33 = $(shearYX33);
const skewYZ33 = $(shearYZ33);
const skewZX33 = $(shearZX33);
const skewZY33 = $(shearZY33);
const skewXY44 = $(shearXY44);
const skewXZ44 = $(shearXZ44);
const skewYX44 = $(shearYX44);
const skewYZ44 = $(shearYZ44);
const skewZX44 = $(shearZX44);
const skewZY44 = $(shearZY44);
export {
  skewX22,
  skewX23,
  skewXY33,
  skewXY44,
  skewXZ33,
  skewXZ44,
  skewY22,
  skewY23,
  skewYX33,
  skewYX44,
  skewYZ33,
  skewYZ44,
  skewZX33,
  skewZX44,
  skewZY33,
  skewZY44
};
