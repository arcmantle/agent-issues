import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

import { type PlanPreview, type PlanPreviewApp } from "./plan-preview-app.js";
import "./plan-preview-app.js";

const app = new App({ name: "Agent Issues Plan Preview", version: "1.0.0" }, {});
const element = document.querySelector("plan-preview-app") as PlanPreviewApp | null;
let actionPending = false;
let appReady: Promise<void>;

async function loadPreview(): Promise<void> {
	const plan = element?.plan;
	if (!element || !plan) {
		return;
	}

	const result = await app.callServerTool({ name: "plan_preview", arguments: { planId: plan.reference } });
	const refreshedPlan = (result.structuredContent as { plan?: PlanPreview } | undefined)?.plan;
	if (!refreshedPlan) {
		throw new Error("The server did not return a Plan Preview.");
	}

	element.plan = refreshedPlan;
}

function toolErrorMessage(result: { content?: Array<{ type: string; text?: string }> }): string {
	const text = result.content?.find((item) => item.type === "text")?.text;
	return text && text.length > 0 ? text : "Plan confirmation failed.";
}

async function confirmPlan(): Promise<void> {
	const plan = element?.plan;
	if (!element || !plan) {
		return;
	}

	const result = await app.callServerTool({
		name: "plan_confirm",
		arguments: { planId: plan.reference, snapshotDigest: plan.snapshotDigest }
	});
	if (result.isError) {
		const message = toolErrorMessage(result);
		if (/snapshot is stale/i.test(message)) {
			await loadPreview();
			element.errorMessage = "Plan changed";
			element.retryAction = async () => runAction(loadPreview);
			return;
		}
		throw new Error(message);
	}

	const messageResult = await app.sendMessage({
		role: "user",
		content: [{ type: "text", text: `Plan confirmed and ready: ${plan.reference}` }]
	});
	if (messageResult.isError) {
		throw new Error("The host rejected the confirmation message.");
	}

	element.plan = { ...plan, status: "ready" };
}

async function returnToPlanning(): Promise<void> {
	const messageResult = await app.sendMessage({ role: "user", content: [{ type: "text", text: "Return to planning." }] });
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
		element.errorMessage = error instanceof Error ? error.message : "Plan Preview could not complete the request.";
	} finally {
		actionPending = false;
	}
}

if (element) {
	element.confirmPlan = async () => runAction(confirmPlan);
	element.returnToPlanning = async () => runAction(returnToPlanning);
	element.openLink = async (url) => {
		const result = await app.openLink({ url });
		if (result.isError) {
			throw new Error("The host rejected the link.");
		}
	};
}

app.ontoolresult = ({ structuredContent }) => {
	const plan = (structuredContent as { plan?: PlanPreview } | undefined)?.plan;
	if (element && plan) {
		element.plan = plan;
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