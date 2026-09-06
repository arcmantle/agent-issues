import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

import { type IssuePreviewApp } from "./issue-preview-app.js";
import "./issue-preview-app.js";

type IssueBreakdownApprovalResult =
	| { status: "approved"; targetReference: string; createdIssueReferences: string[] }
	| { status: "stale"; draft: NonNullable<IssuePreviewApp["draft"]> };

const app = new App({ name: "Agent Issues Issue Preview", version: "1.0.0" }, {});
const element = document.querySelector("issue-preview-app") as IssuePreviewApp | null;
let actionPending = false;
let appReady: Promise<void>;

async function loadPreview(): Promise<void> {
	const draft = element?.draft;
	if (!element || !draft) {
		return;
	}

	const result = await app.callServerTool({ name: "issue_breakdown_preview", arguments: { draftId: draft.id } });
	const refreshedDraft = (result.structuredContent as { draft?: IssuePreviewApp["draft"] } | undefined)?.draft;
	if (!refreshedDraft) {
		throw new Error("The server did not return an Issue Preview.");
	}

	element.draft = refreshedDraft;
}

async function approve(): Promise<void> {
	const draft = element?.draft;
	if (!element || !draft) {
		return;
	}

	const result = await app.callServerTool({
		name: "issue_breakdown_approve",
		arguments: { draftId: draft.id, snapshotDigest: draft.snapshotDigest }
	});
	const approval = result.structuredContent as IssueBreakdownApprovalResult | undefined;
	if (!approval) {
		throw new Error("The server did not return an Issue Preview approval result.");
	}
	if (approval.status === "stale") {
		element.draft = approval.draft;
		element.errorMessage = "Issue breakdown changed";
		return;
	}

	const messageResult = await app.sendMessage({
		role: "user",
		content: [{ type: "text", text: `Issue breakdown approved for ${approval.targetReference}: ${approval.createdIssueReferences.join(", ")}` }]
	});
	if (messageResult.isError) {
		throw new Error("The host rejected the approval message.");
	}
}

async function returnToIssueDesign(): Promise<void> {
	const messageResult = await app.sendMessage({ role: "user", content: [{ type: "text", text: "Return to issue design." }] });
	if (messageResult.isError) {
		throw new Error("The host rejected the return message.");
	}
}

async function runAction(action: () => Promise<void>): Promise<void> {
	if (!element || actionPending) {
		return;
	}

	actionPending = true;
	element.errorMessage = null;
	element.retryAction = async () => runAction(action);
	try {
		await appReady;
		await action();
	} catch (error) {
		element.errorMessage = error instanceof Error ? error.message : "Issue Preview could not complete the request.";
	} finally {
		actionPending = false;
	}
}

if (element) {
	element.approve = async () => runAction(approve);
	element.returnToIssueDesign = async () => runAction(returnToIssueDesign);
}

app.ontoolresult = ({ structuredContent }) => {
	const draft = (structuredContent as { draft?: IssuePreviewApp["draft"] } | undefined)?.draft;
	if (element && draft) {
		element.draft = draft;
		element.errorMessage = null;
	}
};

app.onhostcontextchanged = (context) => {
	if (context.theme) {
		applyDocumentTheme(context.theme);
	}
	if (context.styles?.variables) {
		applyHostStyleVariables(context.styles.variables);
	}
	if (context.styles?.css?.fonts) {
		applyHostFonts(context.styles.css.fonts);
	}
};

appReady = app.connect().then(() => {
	const context = app.getHostContext();
	if (context) {
		app.onhostcontextchanged?.(context);
	}
});