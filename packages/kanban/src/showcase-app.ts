import { provide } from "@lit/context";
import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";
import { when } from "lit/directives/when.js";

import { kanbanButtonRenderServiceContext } from "./components/button/kanban-button.js";
import { kanbanBreadcrumbTrailRenderServiceContext } from "./components/breadcrumb-trail/kanban-breadcrumb-trail.js";
import { kanbanCommentRenderServiceContext } from "./components/comment-item/kanban-comment-item.js";
import { kanbanNavigationTreeRenderServiceContext } from "./components/navigation-tree/kanban-navigation-tree.js";
import { kanbanSidebarRenderServiceContext } from "./components/sidebar/kanban-sidebar.js";
import { kanbanTabsRenderServiceContext } from "./components/tabs/kanban-tabs.js";
import { createButtonShowcaseFixture, type ButtonFixtureRenderService } from "./fixtures/button-fixture.js";
import { createBreadcrumbTrailShowcaseFixture, type BreadcrumbTrailFixtureRenderService } from "./fixtures/breadcrumb-trail-fixture.js";
import { createCommentShowcaseFixture, type CommentFixtureRenderService } from "./fixtures/comment-fixture.js";
import { createNavigationTreeShowcaseFixture, type NavigationTreeFixtureRenderService } from "./fixtures/navigation-tree-fixture.js";
import { createSidebarShowcaseFixture, type SidebarFixtureRenderService } from "./fixtures/sidebar-fixture.js";
import { createTabsShowcaseFixture, type TabsFixtureRenderService } from "./fixtures/tabs-fixture.js";
import { getShowcaseCase, showcaseCases } from "./showcase-cases.js";

@customElement("kanban-showcase")
export class KanbanShowcase extends LitElement {
	@provide({ context: kanbanButtonRenderServiceContext })
	public buttonFixtureService: ButtonFixtureRenderService = createButtonShowcaseFixture();

	@provide({ context: kanbanBreadcrumbTrailRenderServiceContext })
	public breadcrumbTrailFixtureService: BreadcrumbTrailFixtureRenderService = createBreadcrumbTrailShowcaseFixture();

	@provide({ context: kanbanTabsRenderServiceContext })
	public tabsFixtureService: TabsFixtureRenderService = createTabsShowcaseFixture();

	@provide({ context: kanbanCommentRenderServiceContext })
	public commentFixtureService: CommentFixtureRenderService = createCommentShowcaseFixture();

	@provide({ context: kanbanNavigationTreeRenderServiceContext })
	public navigationTreeFixtureService: NavigationTreeFixtureRenderService = createNavigationTreeShowcaseFixture();

	@provide({ context: kanbanSidebarRenderServiceContext })
	public sidebarFixtureService: SidebarFixtureRenderService = createSidebarShowcaseFixture();

	@property({ type: String })
	public componentId: string | undefined;

	protected handleNavigation(event: MouseEvent) {
		const link = event.currentTarget as HTMLAnchorElement;
		event.preventDefault();
		this.dispatchEvent(
			new CustomEvent("kanban-navigate", {
				bubbles: true,
				composed: true,
				detail: { href: link.href }
			})
		);
	}

	protected getSectionLabel(): string {
		const showcaseCase = this.getSelectedCase();
		if (showcaseCase) {
			return showcaseCase.sectionLabel;
		}

		return "Component catalog";
	}

	protected getCaptionDescription(): string {
		const showcaseCase = this.getSelectedCase();
		if (showcaseCase) {
			return showcaseCase.description;
		}

		return "Use the component rail to inspect each registered Kanban element in isolation.";
	}

	protected getCaptionTitle(): string {
		const showcaseCase = this.getSelectedCase();
		if (showcaseCase) {
			return showcaseCase.label;
		}

		return "Component catalog";
	}

	protected getNavigationClass(componentId: string) {
		return classMap({ "is-active": this.componentId === componentId });
	}

	protected getNavigationState(componentId: string): "false" | "page" {
		if (this.componentId === componentId) {
			return "page";
		}

		return "false";
	}

	protected getSelectedCase() {
		return getShowcaseCase(this.componentId);
	}

	protected getStageClass() {
		return classMap({
			"component-stage": true,
			"is-catalog": this.componentId === undefined
		});
	}

	protected renderSelectedCase(componentId: string) {
		const showcaseCase = getShowcaseCase(componentId);
		if (showcaseCase === undefined) {
			return html``;
		}

		return showcaseCase.render();
	}

	protected render() {
		return html`
		<nav
			aria-label="Component selector"
			class="component-rail"
		>
			<div class="rail-title">
				<span aria-hidden="true" class="rail-mark">A</span>
				<span>Concept A</span>
			</div>
			<section
				aria-labelledby="registered-components"
				class="rail-group"
			>
				<h2 id="registered-components">Registered components</h2>
				${map(showcaseCases, (showcaseCase) => html`
				<a
					aria-current=${this.getNavigationState(showcaseCase.id)}
					class=${this.getNavigationClass(showcaseCase.id)}
					href=${`/components/${showcaseCase.id}`}
					@click=${this.handleNavigation}
				>
					${showcaseCase.label}
				</a>
				`)}
			</section>
		</nav>
		<main class="component-workspace">
			<section class="component-draft">
				<header class="draft-caption">
					<span>Concept A component draft</span>
					<h1>${this.getCaptionTitle()}</h1>
					<p>${this.getCaptionDescription()}</p>
				</header>
				<section
					aria-label=${this.getSectionLabel()}
					class=${this.getStageClass()}
				>
				${when(
					this.componentId,
					(componentId) => this.renderSelectedCase(componentId),
					() => map(showcaseCases, (showcaseCase) => html`
					<article class="component-preview">
						<h2>${showcaseCase.label}</h2>
						${showcaseCase.render()}
					</article>
					`)
				)}
				</section>
			</section>
		</main>
		`;
	}

	public static styles = css`
	:host {
		background: var(--color-surface-canvas);
		color: var(--color-text-primary);
		display: block;
		font-family: var(--font-family-ui);
		min-height: 100vh;
	}

	.component-rail {
		background: var(--color-surface-sidebar);
		box-sizing: border-box;
		color: var(--color-text-inverse);
		inset: var(--size-0) auto var(--size-0) var(--size-0);
		overflow-y: auto;
		padding: var(--size-12) var(--size-7);
		position: fixed;
		width: var(--size-104);
		z-index: 1;
	}

	.rail-title {
		align-items: center;
		display: flex;
		font-size: var(--font-size-brand);
		font-weight: var(--font-weight-heavy);
		gap: var(--size-5);
		letter-spacing: var(--letter-spacing-brand);
		padding: var(--size-0) var(--size-4) var(--size-11);
		text-transform: uppercase;
	}

	.rail-mark {
		align-items: center;
		background: var(--color-accent);
		border-radius: var(--radius-control);
		color: var(--color-surface-sidebar);
		display: inline-flex;
		font-size: var(--font-size-meta);
		height: var(--size-13);
		justify-content: center;
		width: var(--size-13);
	}

	.rail-group {
		border-top: var(--border-width) solid var(--color-border-sidebar);
		display: grid;
		gap: var(--size-2);
		margin: var(--size-0);
		padding: var(--size-7) var(--size-0) var(--size-0);
	}

	.rail-group h2 {
		color: var(--color-text-tertiary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		margin: var(--size-0) var(--size-0) var(--size-2);
		padding: var(--size-0) var(--size-4);
		text-transform: uppercase;
	}

	.rail-group a {
		border-radius: var(--radius-control);
		color: var(--color-text-inverse-muted);
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
		padding: var(--size-5) var(--size-4);
		text-decoration: none;
	}

	.rail-group a:hover {
		background: var(--color-surface-sidebar-hover);
		color: var(--color-surface-panel);
	}

	.rail-group a.is-active {
		background: var(--color-surface-sidebar-selected);
		color: var(--color-surface-panel);
	}

	.rail-group a:focus-visible {
		outline: var(--size-1) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}

	.component-workspace {
		box-sizing: border-box;
		margin-left: var(--size-104);
		min-width: 0;
	}

	.component-draft {
		align-items: center;
		background: var(--color-surface-preview);
		box-sizing: border-box;
		display: grid;
		min-height: 100vh;
		padding: var(--size-26) var(--size-12);
	}

	.draft-caption,
	.component-stage {
		width: min(var(--size-560), 100%);
	}

	.draft-caption {
		color: var(--color-text-secondary);
		margin-bottom: var(--size-9);
	}

	.draft-caption > span {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}

	.draft-caption h1 {
		color: var(--color-text-primary);
		font-family: var(--font-family-display);
		font-size: var(--font-size-display);
		font-weight: var(--font-weight-display);
		letter-spacing: var(--size-0);
		line-height: var(--line-height-tight);
		margin: var(--size-2) var(--size-0);
	}

	.draft-caption p {
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		margin: var(--size-0);
		max-width: 68ch;
	}

	.component-stage {
		align-items: center;
		background: var(--color-surface-canvas);
		border: var(--border-width) solid var(--color-border-preview);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-preview);
		box-sizing: border-box;
		display: grid;
		gap: var(--size-12);
		min-height: var(--size-150);
		padding: var(--size-12);
	}

	.component-stage:not(.is-catalog) {
		justify-items: stretch;
	}

	.component-stage.is-catalog {
		align-items: stretch;
		grid-template-columns: repeat(auto-fit, minmax(var(--size-140), 1fr));
	}

	.component-preview {
		background: var(--color-surface-canvas);
		border: var(--border-width) solid var(--color-border-preview);
		border-radius: var(--radius-panel);
		display: grid;
		gap: var(--size-8);
		padding: var(--size-8);
	}

	.component-preview h2 {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		margin: var(--size-0);
		text-transform: uppercase;
	}

	@media (max-width: 47.5rem) {
		.component-rail {
			inset: auto;
			padding: var(--size-8);
			position: static;
			width: auto;
		}

		.rail-title {
			padding-bottom: var(--size-8);
		}

		.rail-group {
			grid-template-columns: repeat(auto-fit, minmax(var(--size-80), 1fr));
		}

		.rail-group h2 {
			grid-column: 1 / -1;
		}

		.component-workspace {
			margin-left: 0;
		}

		.component-draft {
			align-items: start;
			padding: var(--size-18) var(--size-9);
		}
	}

	@media (max-width: 31.25rem) {
		.component-stage {
			padding: var(--size-6);
		}

		.component-stage.is-catalog {
			grid-template-columns: 1fr;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-showcase": KanbanShowcase;
	}
}