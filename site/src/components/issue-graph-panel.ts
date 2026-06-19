import type { Core, ElementDefinition } from "cytoscape";
import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues } from "lit";
import { choose } from "lit/directives/choose.js";
import type { CytoscapeFactory, GraphStatus } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTokenStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

class IssueGraphPanel extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false }
	};

	static styles = [
		issueBrowserTokenStyles,
		issueBrowserTypographyStyles,
		issueBrowserControlStyles,
		css`
		:host {
			display: block;
		}

		.graph-panel {
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--text);
			overflow: hidden;
		}

		.graph-header,
		.graph-footer {
			display: flex;
			justify-content: space-between;
			gap: 12px;
			align-items: center;
			padding: 12px 16px;
			border-bottom: 1px solid var(--border-muted);
			background: var(--surface-muted);
		}

		.graph-header .section-copy,
		.graph-copy,
		.graph-footer {
			color: var(--muted);
		}

		.graph-header h3 {
			color: var(--text);
		}

		.graph-badges .badge {
			border-color: var(--border);
		}

		.graph-shell {
			padding: 0;
			border-top: 1px solid var(--border-muted);
			background:
				radial-gradient(circle at 1px 1px, rgba(31, 35, 40, 0.08) 1px, transparent 0),
				radial-gradient(circle at top, rgba(9, 105, 218, 0.08), transparent 58%),
				linear-gradient(180deg, #ffffff 0%, #f6f8fa 100%);
			background-size: 28px 28px, auto, auto;
			overflow: hidden;
		}

		.graph-stage {
			position: relative;
		}

		.graph-canvas {
			display: block;
			width: 100%;
			min-width: 840px;
			height: 560px;
			position: relative;
		}

		.graph-canvas canvas {
			cursor: grab;
		}

		.graph-overlay {
			position: absolute;
			inset: 0;
			display: grid;
			place-items: center;
			padding: 24px;
			background: rgba(246, 248, 250, 0.85);
			color: var(--muted);
			font-size: 0.9375rem;
			text-align: center;
		}

		.graph-overlay.error {
			color: var(--danger);
		}

		@media (max-width: 800px) {
			.graph-header {
				flex-direction: column;
				align-items: stretch;
			}
		}

		@media (max-width: 640px) {
			.graph-footer {
				padding: 16px;
			}
		}
		`
	];

	public store: AgentIssuesStore | null = null;
	public graph: Core | null = null;
	public graphLibraryPromise: Promise<CytoscapeFactory> | null = null;
	public graphSyncToken = 0;
	public graphSyncScheduled = false;
	public graphSignature = "";
	public graphStatus: GraphStatus = "idle";
	public graphErrorMessage: string | null = null;

	updated(): void {
		super.updated(new Map());
		const store = this.store;
		if (!store) {
			return;
		}

		const activeView = store.activeView.get();
		const entity = store.selectedEntity.get();
		const snapshot = store.snapshot.get();
		const nextSignature = `${activeView}:${entity?.id ?? "none"}:${snapshot?.generatedAt ?? "none"}`;

		if (activeView !== "graph" || !entity) {
			this.graphSignature = "";
			this.graphSyncToken += 1;
			if (this.graph) {
				this.destroyGraph();
			}
			this.setGraphState("idle", null);
			return;
		}

		if (nextSignature !== this.graphSignature) {
			this.graphSignature = nextSignature;
			this.scheduleGraphSync();
		}
	}

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const localGraphEntities = store.localGraphEntities.get();
		const localGraphRelations = store.localGraphRelations.get();

		return html`
		<section class="graph-panel">
			<div class="graph-header">
				<div>
					<h3>Local graph</h3>
					<div class="section-copy">A local neighborhood centered on the current record instead of a workspace-wide diagram.</div>
				</div>
				<div class="graph-badges">
					<span class="badge info">selected</span>
					<span class="badge neutral">neighbors</span>
					<span class="badge warn">blocked / paused</span>
				</div>
			</div>

			<div class="graph-shell">
				<div class="graph-stage">
					<div class="graph-canvas"></div>
					${choose(
						this.graphStatus,
						[
							[
								"loading",
								() => html`<div class="graph-overlay">Loading graph workspace…</div>`
							],
							[
								"error",
								() => html`<div class="graph-overlay error">Could not load the graph view. ${this.graphErrorMessage ?? "Unknown error."}</div>`
							]
						],
						() => html``
					)}
				</div>
			</div>

			<div class="graph-footer">
				<div class="graph-copy">This graph is intentionally local. Use the Issues button to return to the list.</div>
				<div class="badge-row">
					<span class="badge neutral">nodes ${localGraphEntities.length}</span>
					<span class="badge neutral">edges ${localGraphRelations.length}</span>
				</div>
			</div>
		</section>
		`;
	}

	disconnectedCallback(): void {
		this.destroyGraph();
		super.disconnectedCallback();
	}

	protected scheduleGraphSync() {
		if (this.graphSyncScheduled) {
			return;
		}

		this.graphSyncScheduled = true;
		queueMicrotask(() => {
			this.graphSyncScheduled = false;
			void this.syncGraph();
		});
	}

	protected async syncGraph() {
		const store = this.store;
		if (!store) {
			return;
		}

		const currentToken = ++this.graphSyncToken;
		const container = this.renderRoot.querySelector(".graph-canvas");
		const entity = store.selectedEntity.get();
		if (!(container instanceof HTMLDivElement) || !entity) {
			this.destroyGraph();
			return;
		}

		this.destroyGraph();
		this.setGraphState("loading", null);

		let createGraph: CytoscapeFactory;
		try {
			createGraph = await this.loadGraphLibrary();
		} catch (error) {
			if (currentToken !== this.graphSyncToken) {
				return;
			}

			this.setGraphState("error", error instanceof Error ? error.message : String(error));
			return;
		}

		const nextContainer = this.renderRoot.querySelector(".graph-canvas");
		const nextEntity = store.selectedEntity.get();
		if (currentToken !== this.graphSyncToken || !(nextContainer instanceof HTMLDivElement) || !nextEntity) {
			return;
		}

		const graph = createGraph({
			container: nextContainer,
			elements: this.buildGraphElements(store, nextEntity),
			minZoom: 0.5,
			maxZoom: 1.8,
			boxSelectionEnabled: false,
			selectionType: "single",
			style: [
				{
					selector: "node",
					style: {
						shape: "round-rectangle",
						width: 176,
						height: 72,
						padding: "10px",
						"background-color": "#ffffff",
						"border-color": "#d0d7de",
						"border-width": 1.2,
						label: "data(label)",
						color: "#1f2328",
						"font-size": 12,
						"font-weight": 600,
						"text-wrap": "wrap",
						"text-max-width": "146px",
						"text-valign": "center",
						"text-halign": "center",
						"overlay-opacity": 0,
						"active-bg-opacity": 0
					}
				},
				{
					selector: "node.selected",
					style: {
						width: 188,
						height: 80,
						"background-color": "#ddf4ff",
						"border-color": "#0969da",
						"border-width": 2.3,
						color: "#1f2328"
					}
				},
				{
					selector: "node.warn",
					style: {
						"border-color": "#9a6700",
						"background-color": "#fff8c5"
					}
				},
				{
					selector: "node:selected",
					style: {
						"overlay-opacity": 0,
						"active-bg-opacity": 0
					}
				},
				{
					selector: "edge",
					style: {
						width: 1.4,
						"curve-style": "bezier",
						"line-color": "rgba(89, 99, 110, 0.45)",
						"target-arrow-color": "rgba(89, 99, 110, 0.45)",
						"target-arrow-shape": "triangle",
						"arrow-scale": 0.8,
						label: "data(label)",
						color: "#59636e",
						"font-size": 10,
						"text-background-color": "rgba(255, 255, 255, 0.92)",
						"text-background-opacity": 1,
						"text-background-padding": "2px",
						"text-rotation": "autorotate",
						"overlay-opacity": 0,
						"active-bg-opacity": 0
					}
				},
				{
					selector: "edge.direct",
					style: {
						"line-color": "rgba(9, 105, 218, 0.85)",
						"target-arrow-color": "rgba(9, 105, 218, 0.85)",
						width: 2.1,
						color: "#1f2328"
					}
				},
				{
					selector: ":active",
					style: {
						"overlay-opacity": 0,
						"active-bg-opacity": 0
					}
				}
			],
			layout: {
				name: "cose",
				fit: true,
				padding: 44,
				animate: false,
				nodeRepulsion: 220000,
				idealEdgeLength: 180,
				edgeElasticity: 110,
				gravity: 0.48,
				numIter: 1200
			}
		});

		this.graph = graph;
		graph.panningEnabled(true);
		graph.userPanningEnabled(true);
		graph.userZoomingEnabled(true);
		graph.autounselectify(true);
		this.setGraphState("ready", null);

		graph.on("tap", "node", (event) => {
			const nodeId = event.target.data("id") as string | undefined;
			if (nodeId && nodeId !== store.selectedId.get()) {
				store.selectEntity(nodeId);
			}
		});
	}

	protected async loadGraphLibrary() {
		if (!this.graphLibraryPromise) {
			this.graphLibraryPromise = import("cytoscape")
				.then((module) => ("default" in module ? module.default : module) as unknown as CytoscapeFactory)
				.catch((error) => {
					this.graphLibraryPromise = null;
					throw error;
				});
		}

		return this.graphLibraryPromise;
	}

	protected destroyGraph() {
		this.graph?.destroy();
		this.graph = null;
	}

	protected setGraphState(nextStatus: GraphStatus, nextErrorMessage: string | null) {
		if (this.graphStatus === nextStatus && this.graphErrorMessage === nextErrorMessage) {
			return;
		}

		this.graphStatus = nextStatus;
		this.graphErrorMessage = nextErrorMessage;
		this.requestUpdate();
	}

	protected buildGraphElements(store: AgentIssuesStore, entity: { id: string; title: string; status: string }) {
		const nodes = store.localGraphEntities.get().map((graphEntity) => {
			const classes = [graphEntity.id === entity.id ? "selected" : "", graphEntity.status === "blocked" || graphEntity.status === "paused" ? "warn" : ""]
				.filter(Boolean)
				.join(" ");

			return {
				data: {
					id: graphEntity.id,
					label: `${graphEntity.id}\n${store.truncate(graphEntity.title, 30)}`,
					selected: graphEntity.id === entity.id
				},
				classes
			};
		});

		const edges = store.localGraphRelations.get().map((relation) => ({
			data: {
				id: `${relation.fromId}:${relation.type}:${relation.toId}`,
				source: relation.fromId,
				target: relation.toId,
				label: relation.type
			},
			classes: relation.fromId === entity.id || relation.toId === entity.id ? "direct" : ""
		}));

		return [...nodes, ...edges] as ElementDefinition[];
	}
}

customElements.define("agent-issues-graph-panel", IssueGraphPanel);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-graph-panel": IssueGraphPanel;
	}
}