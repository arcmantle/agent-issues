import { html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { Activity, Folders, NotebookPen, Settings, type IconNode } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

interface PageLink {
	page: string;
	label: string;
	symbol: IconNode;
}

export class HarnessApplicationNavigation extends LightElement {
	static override properties = { page: { attribute: false } };

	constructor() {
		super();
		this.page = 'workspace';
	}

	declare page: string;
	protected repositoryPages: PageLink[] = [
		{ page: 'workspace', label: 'Workspace', symbol: Activity },
		{ page: 'planning', label: 'Planning', symbol: NotebookPen },
	];
	protected globalPages: PageLink[] = [
		{ page: 'repositories', label: 'Repositories', symbol: Folders },
		{ page: 'global-settings', label: 'Global Settings', symbol: Settings },
	];

	protected renderLinks(links: PageLink[]) {
		return repeat(
			links,
			(link) => link.page,
			(link) => {
				const current = this.page === link.page ? 'page' : undefined;
				return html`
				<a
					href=${`?page=${link.page}`}
					data-action="page"
					data-page=${link.page}
					aria-label=${link.label}
					aria-current=${ifDefined(current)}
				>
					${renderIcon(link.symbol)}
					<span
						class="page-tooltip"
						aria-hidden="true"
					>
						${link.label}
					</span>
				</a>
				`;
			}
		);
	}

	protected override render() {
		return html`
		<nav
			class="repository-pages"
			aria-label="Repository pages"
		>
			${this.renderLinks(this.repositoryPages)}
		</nav>
		<nav
			class="repository-navigation"
			aria-label="Global navigation"
		>
			${this.renderLinks(this.globalPages)}
		</nav>
		`;
	}
}

customElements.define('harness-application-navigation', HarnessApplicationNavigation);

declare global {
	interface HTMLElementTagNameMap {
		'harness-application-navigation': HarnessApplicationNavigation;
	}
}
