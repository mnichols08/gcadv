import createEle from "../../../utils/createEle.util";
import './footer.style.scss';

const renderFooter = () => {
  createEle(
    "footer",
    `
    &copy; ${new Date().getFullYear()} by <a href="https://www.github.com/mnichols08" target="_blank">mnichols08</a>
    `,
    document.body
  );
};

export default renderFooter;
