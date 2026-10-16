import './application.js';

function handleLibrariesReady() {
	document.querySelector('harness-application')?.requestUpdate();
}

window.addEventListener('load', handleLibrariesReady, { once: true });
