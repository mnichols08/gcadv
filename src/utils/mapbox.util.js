import mapboxgl from "mapbox-gl";
import renderParks from "../views/components/map/parks/park.component";

export const flyToStore = (currentFeature, map) =>
  map.flyTo({
    center: currentFeature.geometry.coordinates,
    zoom: 15,
  });
export const openPopup = (currentFeature, map, e) => {
  renderParks(map, currentFeature);
  const title = currentFeature.properties["Park Name"];
  const coordinates = currentFeature.geometry.coordinates.slice();
  const description = currentFeature.properties.Description;
  const activities = currentFeature.properties.Activities;
  const string = `
    <h3>
      <center>${title}</center>
    </h3>
    </div>
    <div>
      <strong>Description: </strong>${description}
    </div>
    <div>
      <strong>Popular activites include:</strong> ${activities}
    </div>
    `;
  // Ensure that if the map is zoomed out such that multiple
  // copies of the feature are visible, the popup appears
  // over the copy being pointed to.
  if (e)
    while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
      coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
    }
  const popup = document.querySelectorAll(".mapboxgl-popup");
  if (popup.length) popup[0].remove();
  new mapboxgl.Popup().setLngLat(coordinates).setHTML(string).addTo(map);

  // Change the cursor to a pointer when the mouse is over the places layer.
  map.on("mouseenter", "parks", () => {
    map.getCanvas().style.cursor = "pointer";
  });

  // Change it back to a pointer when it leaves.
  map.on("mouseleave", "parks", () => {
    map.getCanvas().style.cursor = "";
  });
  return map;
};
