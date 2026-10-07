import createEle from '../../../utils/createEle.util';
import './header.style.scss';

const renderHeader = () => {
    createEle('header',`
    <h1>Garrett County Adventures</h1>
    `,document.body)
}

export default renderHeader;