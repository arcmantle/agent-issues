// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssueBreakdownDraft } from "@agent-issues/core";

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

function issueBreakdownDraft(): IssueBreakdownDraft {
	return {
		id: "draft-1",
		targetId: "initiative-1",
		targetReference: "INIT_123",
		issues: [],
		snapshotDigest: "a".repeat(64),
		status: "active",
		approvedAt: null,
		createdIssueReferences: []
	};
}

describe("Issue Preview host workflow", () => {
	afterEach(() => {
		document.body.replaceChildren();
		appState.apps.splice(0);
		vi.resetModules();
	});

	it("sends the approved issue references to the host", async () => {
		document.body.innerHTML = "<issue-preview-app></issue-preview-app>";
		await import("./main.js");
		const app = appState.apps[0];
		const element = document.querySelector("issue-preview-app") as HTMLElement & {
			draft: IssueBreakdownDraft;
			errorMessage: string | null;
			approve: () => Promise<void>;
			retryAction: (() => Promise<void>) | undefined;
			returnToIssueDesign: () => Promise<void>;
			updateComplete: Promise<unknown>;
		};
		const draft = issueBreakdownDraft();
		app.ontoolresult?.({ structuredContent: { draft } });
		app.callServerTool.mockResolvedValue({
			structuredContent: {
				status: "approved",
				targetReference: draft.targetReference,
				createdIssueReferences: ["ISS_123", "ISS_456"]
			}
		});
		await element.updateComplete;

		await element.approve();

		expect(app.callServerTool).toHaveBeenCalledWith({
			name: "issue_breakdown_approve",
			arguments: { draftId: draft.id, snapshotDigest: draft.snapshotDigest }
		});
		expect(app.sendMessage).toHaveBeenCalledWith({
			role: "user",
			content: [{ type: "text", text: "Issue breakdown approved for INIT_123: ISS_123, ISS_456" }]
		});
		await element.returnToIssueDesign();
		expect(app.sendMessage).toHaveBeenCalledWith({
			role: "user",
			content: [{ type: "text", text: "Return to issue design." }]
		});

		const changedDraft = { ...draft, snapshotDigest: "b".repeat(64) };
		app.callServerTool.mockResolvedValueOnce({ structuredContent: { status: "stale", draft: changedDraft } });
		await element.approve();
		expect(element.draft).toEqual(changedDraft);
		expect(element.errorMessage).toBe("Issue breakdown changed");
		expect(app.sendMessage).toHaveBeenCalledTimes(2);

		let resolveApproval: (result: unknown) => void;
		app.callServerTool.mockImplementationOnce(() => new Promise((resolve) => {
			resolveApproval = resolve;
		}));
		const firstApproval = element.approve();
		const secondApproval = element.approve();

		await Promise.resolve();
		expect(app.callServerTool).toHaveBeenCalledTimes(3);
		resolveApproval!({
			structuredContent: {
				status: "approved",
				targetReference: changedDraft.targetReference,
				createdIssueReferences: ["ISS_789"]
			}
		});
		await Promise.all([firstApproval, secondApproval]);
		expect(app.sendMessage).toHaveBeenCalledTimes(3);

		app.callServerTool.mockResolvedValueOnce({
			structuredContent: {
				status: "approved",
				targetReference: draft.targetReference,
				createdIssueReferences: ["ISS_123"]
			}
		});
		app.sendMessage.mockResolvedValue({ isError: true });
		await element.approve();

		expect(element.errorMessage).toBe("The host rejected the approval message.");
		app.sendMessage.mockResolvedValue({});
		await element.retryAction?.();
		expect(app.sendMessage).toHaveBeenLastCalledWith({
			role: "user",
			content: [{ type: "text", text: "Issue breakdown approved for INIT_123: ISS_123, ISS_456" }]
		});
	});
});