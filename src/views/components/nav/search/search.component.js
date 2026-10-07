import createEle from "../../../../utils/createEle.util";
import { fetchJson } from "../../../../controller";
import renderLocations from "../locations/renderLocations.component";
import renderParks from "../../map/parks/park.component";
import "./search.style.scss";

const renderSearch = (anchor, map) => {
  const input = createEle("input", ``, anchor);
  const ul = createEle("ul", "", anchor);
  const geojson = fetchJson().features;
  let value;
  input.placeholder = "search";
  input.onkeyup = (e) => {
    document.querySelectorAll(".marker").forEach((marker) => marker.remove());
    value = e.target.value.trim().toLowerCase();
    renderLocations(ul, map, value);
    geojson
      .filter((featProps) => {
        const keys = Object.keys(featProps.properties);
        const props = keys.map((key) => featProps.properties[key]);
        return props.toString().toLowerCase().includes(value);
      })
      .forEach((feature) => {
        renderParks(map, feature);

        document.getElementById(`marker-${feature.properties.id}`).onclick =
          () =>
            document.getElementById(`listing-${feature.properties.id}`).click();
      });
  };
  renderLocations(ul, map);

  fetchJson().features.forEach((feature) => renderParks(map, feature));

  return input;
};

export default renderSearch;
