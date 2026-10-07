import { flyToStore, openPopup } from "../../../../utils/mapbox.util";
import "./popup.style.scss";

const renderPopups = (map) => {
  map.on("click", "parks", (e) => {
    flyToStore(e.features[0], map);
    openPopup(e.features[0], map, e);
  });
};

export default renderPopups;
