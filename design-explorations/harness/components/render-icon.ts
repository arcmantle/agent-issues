import { createElement, type IconNode } from 'lucide';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';

export function renderIcon(symbol: IconNode) {
	return unsafeSVG(createElement(symbol, { 'aria-hidden': 'true' }).outerHTML);
}
