import { html } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { FilePlus2, GitMerge } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface MergeFileModel {
	path: string;
	conflict: boolean;
	status: string;
}

export class HarnessMergeFiles extends LightElement {
	static override properties = {
		files: { attribute: false },
		selected: { attribute: false },
	};

	constructor() {
		super();
		this.files = [];
		this.selected = 0;
	}

	declare files: MergeFileModel[];
	declare selected: number;

	protected override render() {
		return html`
		<div
			class="file-tabs"
			role="group"
			aria-label="Changed files"
		>
			${repeat(
					this.files,
					(file) => file.path,
					(file, index) => {
						const symbol = file.conflict ? GitMerge : FilePlus2;
						return html`
						<button
							data-action="file"
							data-value=${index}
							title=${file.path}
							aria-pressed=${live(String(this.selected === index))}
						>
							${renderIcon(symbol)}<span>${file.path}</span
							><span class="file-status">${file.status}</span>
						</button>
						`;
					}
				)}
		</div>
		`;
	}
}

customElements.define('harness-merge-files', HarnessMergeFiles);

declare global {
	interface HTMLElementTagNameMap {
		'harness-merge-files': HarnessMergeFiles;
	}
}
