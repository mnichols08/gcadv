import mapboxgl from "mapbox-gl";
import init from "./views/init";
import geojson from "./model/geo.json" assert { type: "json" };

export const generateMap = (id, bounds) => {
  let boundaries;
  if (bounds)
    boundaries = [
      [-79.48696767001076, 39.202068911240104], // Southwest coordinates
      [-79.08637004392415, 39.722221540464716], // Northeast coordinates
    ];
  if (!mapboxgl.accessToken || !mapboxgl.accessToken.startsWith("pk.")) {
    throw new Error("Configure a public Mapbox token before creating the map.");
  }
  const map = new mapboxgl.Map({
    container: id, // container ID
    style: "mapbox://styles/mapbox/outdoors-v12", // style URL
    center: [-79.312, 39.505], // starting position [lng, lat]
    zoom: 12, // starting zoom
    maxBounds: boundaries,
  });
  return map;
};

export const fetchJson = () => geojson;

const controller = () => {
  return {
    generateMap, fetchJson
  };
};

export default controller;

document.body.onload = init;
