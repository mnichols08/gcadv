import { fetchJson } from "../../../../controller";
import { flyToStore, openPopup } from "../../../../utils/mapbox.util";
import mapboxgl from "mapbox-gl";
import "./park.style.scss";
const renderParks = (map, feature) => {
  // create a HTML element for each feature
  const el = document.createElement("div");
  el.className = "marker";
  el.id = `marker-${feature.properties.id}`;
  new mapboxgl.Marker(el)
    .setLngLat(feature.geometry.coordinates.slice())
    .addTo(map);
  el.onclick = function () {
    document.getElementById(`link-${feature.properties.id}`).click();
    openPopup(map, feature);
  };
};

export default renderParks;
