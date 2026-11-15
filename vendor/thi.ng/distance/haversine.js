import {
  distHaversineLatLon,
  distHaversineLonLat
} from "@thi.ng/vectors/dist-haversine";
import { Untransformed } from "./untransformed.js";
const HAVERSINE_LATLON = new Untransformed(
  distHaversineLatLon
);
const HAVERSINE_LONLAT = new Untransformed(
  distHaversineLonLat
);
export {
  HAVERSINE_LATLON,
  HAVERSINE_LONLAT
};
