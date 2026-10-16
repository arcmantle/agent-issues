import { html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { LightElement } from './light-element.js';
import { type IssueModel } from './issue-card.js';
import './issue-card.js';

export class HarnessIssueList extends LightElement {
	static override properties = {
		issues: { attribute: false },
		listClass: { attribute: false },
	};

	constructor() {
		super();
		this.issues = [];
		this.listClass = 'route-issues';
	}

	declare issues: IssueModel[];
	declare listClass: string;

	protected override render() {
		return html`
		<ul class=${this.listClass}>
			${repeat(
					this.issues,
					(issue) => issue.index,
					(issue) => html`
					<li>
						<harness-issue-card .issue=${issue}></harness-issue-card>
					</li>
					`
				)}
		</ul>
		`;
	}
}

customElements.define('harness-issue-list', HarnessIssueList);

declare global {
	interface HTMLElementTagNameMap {
		'harness-issue-list': HarnessIssueList;
	}
}
