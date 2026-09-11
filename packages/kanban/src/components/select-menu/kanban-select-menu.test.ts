import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanSelectMenuRenderServiceContext,
	type KanbanSelectMenuState
} from "./kanban-select-menu.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanSelectMenu", () => {
	it("renders a labeled native select from its typed render service", async () => {
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select: () => undefined,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: false,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "In progress", value: "In progress" },
					{ label: "Blocked", value: "Blocked" },
					{ label: "Done", value: "Done" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		document.body.append(element);
		await element.updateComplete;

		const label = element.shadowRoot?.querySelector("label");
		const nativeSelect = element.shadowRoot?.querySelector<HTMLSelectElement>("select");
		expect(label?.textContent).toContain("Status");
		expect(label?.htmlFor).toBe(nativeSelect?.id);
		expect(nativeSelect?.name).toBe("status");
		expect(nativeSelect?.value).toBe("Todo");
		expect([ ...(nativeSelect?.options ?? []) ].map((option) => option.value)).toEqual([
			"Todo",
			"In progress",
			"Blocked",
			"Done"
		]);
	});

	it("sends a select intent when the native control changes", async () => {
		const select = vi.fn();
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: false,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "In progress", value: "In progress" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		const intent = vi.fn();
		element.addEventListener("kanban-select-menu-change", intent);
		document.body.append(element);
		await element.updateComplete;

		const nativeSelect = element.shadowRoot?.querySelector<HTMLSelectElement>("select");
		if (nativeSelect === undefined || nativeSelect === null) {
			throw new Error("expected a native select");
		}

		nativeSelect.value = "In progress";
		nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await element.updateComplete;

		expect(select).toHaveBeenCalledWith("In progress");
		expect(intent).toHaveBeenCalledOnce();
		expect(intent.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				detail: { name: "status", value: "In progress" }
			})
		);
	});

	it("updates the selected option when its service signal changes", async () => {
		const selectMenu = signal<KanbanSelectMenuState>({
			disabled: false,
			label: "Status",
			name: "status",
			options: [
				{ label: "Todo", value: "Todo" },
				{ label: "Done", value: "Done" }
			],
			value: "Todo"
		});
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select: () => undefined,
			selectMenu
		});
		const element = document.createElement("kanban-select-menu");
		document.body.append(element);
		await element.updateComplete;

		selectMenu.set({
			disabled: false,
			label: "Workflow status",
			name: "status",
			options: [
				{ label: "Todo", value: "Todo" },
				{ label: "Done", value: "Done" }
			],
			value: "Done"
		});
		await element.updateComplete;

		const nativeSelect = element.shadowRoot?.querySelector<HTMLSelectElement>("select");
		expect(element.shadowRoot?.querySelector("label")?.textContent).toContain("Workflow status");
		expect(nativeSelect?.value).toBe("Done");
	});

	it("renders a disabled native select without sending a select intent", async () => {
		const select = vi.fn();
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: true,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "Done", value: "Done" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		const intent = vi.fn();
		element.addEventListener("kanban-select-menu-change", intent);
		document.body.append(element);
		await element.updateComplete;

		const nativeSelect = element.shadowRoot?.querySelector<HTMLSelectElement>("select");
		expect(nativeSelect?.disabled).toBe(true);
		nativeSelect?.dispatchEvent(new Event("change", { bubbles: true }));
		expect(select).not.toHaveBeenCalled();
		expect(intent).not.toHaveBeenCalled();
	});
});
