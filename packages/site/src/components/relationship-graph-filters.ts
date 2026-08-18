import { LitElement, css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { PROJECT_GRAPH_KINDS, type ProjectGraphKind } from "../models.js";

const GRAPH_KIND_DETAILS: Record<ProjectGraphKind, { color: string; label: string }> = {
	adr: { color: "#8250df", label: "ADR" },
	debt: { color: "#bf3989", label: "Debt" },
	epic: { color: "#9a6700", label: "Epic" },
	initiative: { color: "#0969da", label: "Initiative" },
	issue: { color: "#0a7ea4", label: "Issue" },
	plan: { color: "#8250df", label: "Plan" },
	prd: { color: "#1f883d", label: "PRD" },
	project: { color: "#24292f", label: "Project" },
	story: { color: "#bf8700", label: "User story" }
};

class RelationshipGraphFilters extends LitElement {
	static properties = {
		kinds: { attribute: false },
		visibleKinds: { attribute: false }
	};

	public kinds: ProjectGraphKind[] = [...PROJECT_GRAPH_KINDS];
	public visibleKinds: ReadonlySet<ProjectGraphKind> = new Set(PROJECT_GRAPH_KINDS);

	protected onToggleKind = (event: Event) => {
		const kind = (event.currentTarget as HTMLElement).dataset.graphKind as ProjectGraphKind | undefined;
		if (!kind) {
			return;
		}

		this.dispatchEvent(
			new CustomEvent<{ kind: ProjectGraphKind }>("graph-kind-toggle", {
				bubbles: true,
				composed: true,
				detail: { kind }
			})
		);
	};

	protected toAriaBoolean(value: boolean): "true" | "false" {
		return value ? "true" : "false";
	}

	render() {
		return html`
		<div
			aria-label="Filter graph records"
			class="graph-kind-filters"
			role="group"
		>
			${repeat(
				this.kinds,
				(kind) => kind,
				(kind) => {
					const detail = GRAPH_KIND_DETAILS[kind];
					const isVisible = this.visibleKinds.has(kind);
					return html`
					<button
						aria-pressed=${this.toAriaBoolean(isVisible)}
						class=${classMap({ active: isVisible, "graph-kind-chip": true })}
						data-graph-kind=${kind}
						@click=${this.onToggleKind}
					>
						<span
							class="sw"
							style=${`background:${detail.color}`}
						></span>
						${detail.label}
					</button>
					`;
				}
			)}
		</div>
		`;
	}

	static styles = css`
	:host {
		display: contents;
	}
	.graph-kind-filters {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.graph-kind-chip {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		padding: 5px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--muted);
		cursor: pointer;
		font: inherit;
		font-size: 12px;
	}
	.graph-kind-chip.active {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 600;
	}
	.sw {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}
	`;
}

customElements.define("agent-issues-relationship-graph-filters", RelationshipGraphFilters);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-relationship-graph-filters": RelationshipGraphFilters;
	}
	interface HTMLElementEventMap {
		"graph-kind-toggle": CustomEvent<{ kind: ProjectGraphKind }>;
	}
}