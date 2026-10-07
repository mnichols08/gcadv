import { generateMap } from "../../../controller";
import { anchor } from "../../../utils/clear.util";
import createEle from "../../../utils/createEle.util";
import renderPopups from './popup/popup.component';
import "mapbox-gl/dist/mapbox-gl.css";
import "./map.style.scss";

const renderMap = (id) => {
  createEle("div", "", anchor, id);
  const map = generateMap(id, true);
  renderPopups(map);
  return map;
};

export default renderMap;
