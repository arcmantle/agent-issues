import { afterEach, describe, expect, it } from "vitest";

import "./kanban-app.js";

afterEach(() => {
	document.body.replaceChildren();
	window.history.replaceState({}, "", "/");
});

describe("Kanban application routes", () => {
	it("keeps the board at the root route", async () => {
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector(".board-shell")).not.toBeNull();
		expect(app.shadowRoot?.querySelector("kanban-showcase")).toBeNull();
	});

	it("renders the fixture catalog at the components route", async () => {
		window.history.replaceState({}, "", "/components");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase).not.toBeNull();
		await showcase?.updateComplete;

		expect(showcase?.shadowRoot?.querySelector("kanban-button")).not.toBeNull();
	});

	it("navigates from the catalog to the selected component", async () => {
		window.history.replaceState({}, "", "/components");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-showcase");
		await showcase?.updateComplete;
		showcase?.shadowRoot?.querySelector<HTMLAnchorElement>('a[href="/components/kanban-button"]')?.click();
		await app.updateComplete;

		const selectedShowcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string }>("kanban-showcase");
		expect(selectedShowcase?.componentId).toBe("kanban-button");
		expect(window.location.pathname).toBe("/components/kanban-button");
	});

	it("renders the deterministic button fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-button");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase).not.toBeNull();
		expect(showcase?.componentId).toBe("kanban-button");
		await showcase?.updateComplete;

		const button = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-button");
		expect(button).not.toBeNull();
		await button?.updateComplete;
		expect(button?.shadowRoot?.textContent).toContain("Create issue");
		expect(button?.shadowRoot?.querySelector(".is-primary")).not.toBeNull();
	});

	it("renders the deterministic Tabs fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-tabs");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-tabs");
		await showcase?.updateComplete;

		const tabs = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-tabs");
		expect(tabs).not.toBeNull();
		await tabs?.updateComplete;
		expect(tabs?.shadowRoot?.querySelector("[aria-current=page]")?.textContent).toContain("Issues");
		tabs?.shadowRoot?.querySelector<HTMLButtonElement>("[data-tab-id=plans]")?.click();
		await tabs?.updateComplete;
		expect(tabs?.shadowRoot?.querySelector("[aria-current=page]")?.textContent).toContain("Plans");
	});

	it("renders the deterministic Breadcrumb trail fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-breadcrumb-trail");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-breadcrumb-trail");
		await showcase?.updateComplete;

		const breadcrumbTrail = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-breadcrumb-trail");
		expect(breadcrumbTrail).not.toBeNull();
		await breadcrumbTrail?.updateComplete;
		expect(breadcrumbTrail?.shadowRoot?.querySelector("li[aria-current=page]")?.textContent).toContain("Portable Kanban design system");
	});

	it("renders the deterministic Comment item fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-comment-item");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-comment-item");
		await showcase?.updateComplete;

		const comment = showcase?.shadowRoot?.querySelector("kanban-comment-item");
		expect(comment).not.toBeNull();
	});

	it("renders the deterministic Sidebar fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-sidebar");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-sidebar");
		await showcase?.updateComplete;

		const sidebar = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-sidebar");
		expect(sidebar).not.toBeNull();
		await sidebar?.updateComplete;
		expect(sidebar?.shadowRoot?.querySelector("aside")?.getAttribute("aria-label")).toBe("Project and initiative navigation");
		expect(sidebar?.shadowRoot?.textContent).toContain("agent-issues");
	});

	it("renders the deterministic Navigation tree fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-navigation-tree");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-navigation-tree");
		await showcase?.updateComplete;

		const navigationTree = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-navigation-tree");
		expect(navigationTree).not.toBeNull();
		await navigationTree?.updateComplete;
		expect(navigationTree?.shadowRoot?.querySelector("button[aria-current=page]")?.textContent).toContain("Implement Navigation tree component");
	});

	it("renders a return-to-catalog state for an unknown component", async () => {
		window.history.replaceState({}, "", "/components/unknown-component");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector(".not-found")).not.toBeNull();
		expect(app.shadowRoot?.textContent).toContain("unknown-component");
		expect(app.shadowRoot?.querySelector('a[href="/components"]')).not.toBeNull();
	});
});