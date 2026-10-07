import createEle from "../../../utils/createEle.util";
import renderSearch from "./search/search.component";
import "./nav.style.scss";

const renderNav = (map) => {
  const nav = createEle(
    "nav",
    `
    `,
    document.body
  );
  createEle("h2", "Nearby Parks", nav);
  renderSearch(nav, map);
  return nav;
};

export default renderNav;
