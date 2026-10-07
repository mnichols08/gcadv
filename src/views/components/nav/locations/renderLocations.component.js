import { flyToStore, openPopup } from "../../../../utils/mapbox.util";
import { fetchJson } from "../../../../controller";
import createEle from "../../../../utils/createEle.util";

const renderLocations = (anchor, map, search) => {
  const data = fetchJson();
  const parks = search
    ? data.features.filter((featProps) => {
        const keys = Object.keys(featProps.properties);
        const props = keys.map((key) => featProps.properties[key]);
        return props.toString().toLowerCase().includes(search.toLowerCase());
      })
    : data.features;
  anchor.innerHTML = ``; // clear the anchor
  parks.forEach((park, i) => (park.properties.id = i));
  for (const park of parks) {
    const location = createEle(
      "div",
      "",
      anchor,
      `listing-${park.properties.id}`,
      "item"
    );
    const link = createEle(
      "a",
      `${park.properties["Park Name"]}`,
      location,
      `link-${park.properties.id}`,
      "title"
    );
    link.href = "#";
    link.onclick = function () {
      for (const feature of parks) {
        if (this.id === `link-${feature.properties.id}`) {
          flyToStore(feature, map);
          openPopup(feature, map);
          console.log("tell mehow the efff this is possible?!");
        }
      }
    };
  }
};

export default renderLocations;
