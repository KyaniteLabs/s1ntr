import { setS3 } from "@thi.ng/vectors/sets";
const mat44to33 = (out, m44) => (!out && (out = []), setS3(out, m44), setS3(out, m44, 3, 4), setS3(out, m44, 6, 8));
export {
  mat44to33
};
