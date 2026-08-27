import { SignalWatcher, signal } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";

import "./showcase-app.js";
import { getShowcaseCase } from "./showcase-cases.js";

type KanbanRoute = {
	componentId?: string;
	kind: "board" | "showcase" | "showcase-not-found";
};

const currentPath = signal(window.location.pathname);

function resolveRoute(pathname: string): KanbanRoute {
	if (pathname === "/") {
		return { kind: "board" };
	}

	if (pathname === "/components") {
		return { kind: "showcase" };
	}

	if (pathname.startsWith("/components/")) {
		const componentId = pathname.slice("/components/".length);
		if (getShowcaseCase(componentId)) {
			return { componentId, kind: "showcase" };
		}

		return { componentId, kind: "showcase-not-found" };
	}

	return { kind: "board" };
}

@customElement("kanban-app")
export class KanbanApp extends SignalWatcher(LitElement) {
	public connectedCallback() {
		super.connectedCallback();
		currentPath.set(window.location.pathname);
		window.addEventListener("popstate", this.handlePopState);
	}

	public disconnectedCallback() {
		window.removeEventListener("popstate", this.handlePopState);
		super.disconnectedCallback();
	}

	protected handleNavigation(event: MouseEvent) {
		const link = event.currentTarget as HTMLAnchorElement;
		event.preventDefault();
		window.history.pushState({}, "", link.href);
		currentPath.set(window.location.pathname);
	}

	protected handleKanbanNavigation(event: CustomEvent<{ href: string }>) {
		window.history.pushState({}, "", event.detail.href);
		currentPath.set(window.location.pathname);
	}

	protected handlePopState = () => {
		currentPath.set(window.location.pathname);
	};

	protected render() {
		const route = resolveRoute(currentPath.get());

		return choose(route.kind, [
			[
				"board",
				() => html`
				<main class="board-shell">
					<header>
						<h1>Kanban board</h1>
						<a
							@click=${this.handleNavigation}
							href="/components"
						>
							Components
						</a>
					</header>
					<section aria-label="Board">
						<p>Board data will appear here.</p>
					</section>
				</main>
				`
			],
			[
				"showcase",
				() => html`
					<kanban-showcase
						.componentId=${route.componentId}
						@kanban-navigate=${this.handleKanbanNavigation}
					></kanban-showcase>
				`
			],
			[
				"showcase-not-found",
				() => html`
				<main class="not-found">
					<h1>Component unavailable</h1>
					<p>${route.componentId} is not in the component catalog.</p>
					<a
						@click=${this.handleNavigation}
						href="/components"
					>
						Return to components
					</a>
				</main>
				`
			]
		]);
	}

	public static styles = css`
	:host {
		display: block;
		min-height: 100vh;
	}

	.board-shell,
	.not-found {
		background: var(--color-surface-canvas);
		color: var(--color-text-primary);
		font-family: var(--font-family-ui);
		min-height: 100vh;
		padding: var(--size-12);
	}

	.board-shell header {
		align-items: center;
		display: flex;
		justify-content: space-between;
	}

	.board-shell h1,
	.not-found h1 {
		font-family: var(--font-family-display);
		font-size: var(--font-size-display);
		font-weight: var(--font-weight-display);
		line-height: var(--line-height-tight);
		margin: var(--size-0);
	}

	.board-shell a,
	.not-found a {
		color: var(--color-status-success-text);
		font-weight: var(--font-weight-strong);
	}

	.board-shell section {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-panel);
		margin-top: var(--size-16);
		min-height: var(--size-125);
		padding: var(--size-12);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-app": KanbanApp;
	}
}