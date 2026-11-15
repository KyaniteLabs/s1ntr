const encode5 = (x) => {
  x &= 31;
  x = x * 17043521 & 270549121;
  x = x * 1082401 & 357564416;
  return x >>> 20;
};
const encode10 = (x) => {
  x &= 1023;
  x = (x | x << 16) & 4278190335;
  x = (x | x << 8) & 50393103;
  x = (x | x << 4) & 51130563;
  x = (x | x << 2) & 153391689;
  return x >>> 0;
};
const encode16 = (x) => {
  x &= 65535;
  x = (x | x << 8) & 16711935;
  x = (x | x << 4) & 252645135;
  x = (x | x << 2) & 858993459;
  x = (x | x << 1) & 1431655765;
  return x >>> 0;
};
const decode5 = (x) => {
  x &= 341;
  x = (x | x >> 1) & 307;
  x = (x | x >> 2) & 271;
  x = (x | x >> 4) & 31;
  return x;
};
const decode10 = (x) => {
  x &= 153391689;
  x = (x | x >> 2) & 51130563;
  x = (x | x >> 4) & 50393103;
  x = (x | x >> 8) & 4278190335;
  x = (x | x >> 16) & 1023;
  return x;
};
const decode16 = (x) => {
  x &= 1431655765;
  x = (x | x >> 1) & 858993459;
  x = (x | x >> 2) & 252645135;
  x = (x | x >> 4) & 16711935;
  x = (x | x >> 8) & 65535;
  return x;
};
export {
  decode10,
  decode16,
  decode5,
  encode10,
  encode16,
  encode5
};
