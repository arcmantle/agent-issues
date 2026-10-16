import { html, nothing } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { FolderGit2, Settings2 } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface RepositoryModel {
	name: string;
	path: string;
	projectIdentity?: string;
	tenant: string;
}

export class HarnessRepositoryHeader extends LightElement {
	static override properties = {
		repository: { attribute: false },
		page: { attribute: false },
	};

	constructor() {
		super();
		this.repository = undefined;
		this.page = 'workspace';
	}

	declare repository: RepositoryModel | undefined;
	declare page: string;

	protected override render() {
		const repository = this.repository;
		if (!repository) return nothing;
		const current = this.page === 'project-settings' ? 'page' : undefined;
		return html`
		<div
			role="region"
			aria-label="Current repository"
		>
			<div class="repository-heading">
				<div class="brand current-project">
					<span>${renderIcon(FolderGit2)}</span><span>${repository.name}</span>
				</div>
				<a
					class="project-settings-link"
					href="/?page=project-settings"
					data-action="page"
					data-page="project-settings"
					aria-label="Project Settings"
					title="Project Settings"
					aria-current=${ifDefined(current)}
				>
					${renderIcon(Settings2)}
				</a>
			</div>
			<p class="repository-path mono muted">${repository.path}</p>
			<p class="repository-project muted">
				Project / ${repository.projectIdentity || 'Not connected'}
			</p>
			<p class="muted">Tenant / ${repository.tenant}</p>
		</div>
		`;
	}
}

customElements.define('harness-repository-header', HarnessRepositoryHeader);

declare global {
	interface HTMLElementTagNameMap {
		'harness-repository-header': HarnessRepositoryHeader;
	}
}
