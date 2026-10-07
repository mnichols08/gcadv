import renderHeader from "../components/header/header.component";
import renderNav from "../components/nav/nav.component";
import renderMap from "../components/map/map.component";
import renderFooter from "../components/footer/footer.component";
import "./index.styles.scss";

const indexPage = () => {
  const map = renderMap("map"); // createes our map and assigns a varible
  renderHeader(); // calls function to render header
  renderNav(map); // calls function to render nav, passing in the map component
  renderFooter(); // calls function to render footer
};

export default indexPage;
