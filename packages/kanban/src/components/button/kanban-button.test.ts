import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import { kanbanButtonRenderServiceContext, type KanbanButtonState } from "./kanban-button.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanButton", () => {
	it("renders typed service data and sends an activation intent", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanButtonRenderServiceContext, {
			activate,
			button: signal<KanbanButtonState>({ disabled: false, label: "Create issue", loading: false, variant: "primary" })
		});
		const button = document.createElement("kanban-button");
		document.body.append(button);
		await button.updateComplete;

		const nativeButton = button.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.textContent).toContain("Create issue");
		expect(nativeButton?.classList.contains("is-primary")).toBe(true);
		nativeButton?.click();

		expect(activate).toHaveBeenCalledOnce();
	});
});