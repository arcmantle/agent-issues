import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

import { type PlanPreview, type PlanPreviewApp } from "./plan-preview-app.js";
import "./plan-preview-app.js";

const app = new App({ name: "Agent Issues Plan Preview", version: "1.0.0" }, {});
const element = document.querySelector("plan-preview-app") as PlanPreviewApp | null;

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

async function confirmPlan(): Promise<void> {
	const plan = element?.plan;
	if (!element || !plan) {
		return;
	}

	await app.sendMessage({
		role: "user",
		content: [{ type: "text", text: `Confirm Proposed Plan: ${plan.reference} (snapshot digest: ${plan.snapshotDigest})` }]
	});
}

async function returnToPlanning(): Promise<void> {
	await app.sendMessage({ role: "user", content: [{ type: "text", text: "Return to planning." }] });
}

async function runAction(action: () => Promise<void>): Promise<void> {
	if (!element) {
		return;
	}

	element.errorMessage = null;
	element.retryAction = async () => runAction(action);
	try {
		await action();
	} catch (error) {
		element.errorMessage = error instanceof Error ? error.message : "Plan Preview could not complete the request.";
	}
}

if (element) {
	element.confirmPlan = async () => runAction(confirmPlan);
	element.returnToPlanning = async () => runAction(returnToPlanning);
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

void app.connect().then(() => {
	const context = app.getHostContext();
	if (context) {
		app.onhostcontextchanged?.(context);
	}
});