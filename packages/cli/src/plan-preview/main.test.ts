// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProposedPlan } from "@agent-issues/core";

const appState = vi.hoisted(() => ({
	apps: [] as Array<{
		callServerTool: ReturnType<typeof vi.fn>;
		sendMessage: ReturnType<typeof vi.fn>;
		ontoolresult?: (result: { structuredContent?: unknown }) => void;
	}>
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
	App: class {
		public callServerTool = vi.fn();
		public sendMessage = vi.fn().mockResolvedValue({});
		public openLink = vi.fn().mockResolvedValue({});
		public ontoolresult?: (result: { structuredContent?: unknown }) => void;
		public onhostcontextchanged?: () => void;

		constructor() {
			appState.apps.push(this);
		}

		public async connect(): Promise<void> {}

		public getHostContext(): undefined {
			return undefined;
		}
	},
	applyDocumentTheme: vi.fn(),
	applyHostFonts: vi.fn(),
	applyHostStyleVariables: vi.fn()
}));

function proposedPlan(): ProposedPlan & { status: string; revision: number } {
	return {
		reference: "PLAN_123",
		title: "Plan Preview Design",
		goal: "Review the Plan before it becomes ready.",
		context: "Use the MCP Apps contract.",
		revision: 3,
		current: [],
		hasActiveQuestions: false,
		snapshotDigest: "a".repeat(64),
		status: "in-progress"
	};
}

describe("Plan Preview host workflow", () => {
	afterEach(() => {
		document.body.replaceChildren();
		appState.apps.splice(0);
		vi.resetModules();
	});

	it("confirms the reviewed snapshot through the host and reports Plan ready", async () => {
		document.body.innerHTML = "<plan-preview-app></plan-preview-app>";
		await import("./main.js");
		const app = appState.apps[0];
		const element = document.querySelector("plan-preview-app") as HTMLElement & {
			plan: ProposedPlan & { status: string };
			errorMessage: string | null;
			confirmPlan: () => Promise<void>;
			retryAction: (() => Promise<void>) | undefined;
			returnToPlanning: () => Promise<void>;
			updateComplete: Promise<unknown>;
		};
		const plan = proposedPlan();
		app.ontoolresult?.({ structuredContent: { plan } });
		app.callServerTool.mockResolvedValue({
			structuredContent: {
				entity: { reference: plan.reference, status: "ready" },
				previousStatus: "in-progress",
				confirmed: true
			}
		});
		await element.updateComplete;

		await element.confirmPlan();

		expect(app.callServerTool).toHaveBeenCalledWith({
			name: "plan_confirm",
			arguments: { planId: plan.reference, snapshotDigest: plan.snapshotDigest }
		});
		expect(app.sendMessage).toHaveBeenCalledWith({
			role: "user",
			content: [{ type: "text", text: "Plan confirmed and ready: PLAN_123" }]
		});
		expect(element.plan.status).toBe("ready");

		await element.returnToPlanning();
		expect(app.sendMessage).toHaveBeenCalledWith({
			role: "user",
			content: [{ type: "text", text: "Return to planning." }]
		});

		const changedPlan = { ...plan, snapshotDigest: "b".repeat(64), goal: "The Goal changed." };
		app.callServerTool
			.mockResolvedValueOnce({
				isError: true,
				content: [{ type: "text", text: "Plan snapshot is stale: PLAN_123" }]
			})
			.mockResolvedValueOnce({ structuredContent: { plan: changedPlan } });
		await element.confirmPlan();
		expect(element.plan).toEqual(changedPlan);
		expect(element.errorMessage).toBe("Plan changed");
		expect(app.sendMessage).toHaveBeenCalledTimes(2);

		let resolveConfirmation: (result: unknown) => void;
		app.callServerTool.mockImplementationOnce(() => new Promise((resolve) => {
			resolveConfirmation = resolve;
		}));
		const firstConfirmation = element.confirmPlan();
		const secondConfirmation = element.confirmPlan();
		await Promise.resolve();
		expect(app.callServerTool).toHaveBeenCalledTimes(4);
		resolveConfirmation!({
			structuredContent: {
				entity: { reference: changedPlan.reference, status: "ready" },
				previousStatus: "in-progress",
				confirmed: true
			}
		});
		await Promise.all([firstConfirmation, secondConfirmation]);
		expect(app.sendMessage).toHaveBeenCalledTimes(3);

		app.callServerTool.mockResolvedValueOnce({
			structuredContent: {
				entity: { reference: changedPlan.reference, status: "ready" },
				previousStatus: "ready",
				confirmed: false
			}
		});
		app.sendMessage.mockResolvedValue({ isError: true });
		await element.confirmPlan();
		expect(element.errorMessage).toBe("The host rejected the confirmation message.");
		app.sendMessage.mockResolvedValue({});
		await element.retryAction?.();
		expect(app.sendMessage).toHaveBeenLastCalledWith({
			role: "user",
			content: [{ type: "text", text: "Plan confirmed and ready: PLAN_123" }]
		});
	});
});
