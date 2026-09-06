// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { ProposedPlan } from "@agent-issues/core";
import "./plan-preview-app.js";

function proposedPlan(): ProposedPlan & { status: string } {
	return {
		reference: "PLAN_123",
		title: "Plan Preview Design",
		goal: "Review the Plan before it becomes ready.",
		context: "Use the MCP Apps contract.",
		current: [
			{
				key: "decisions",
				title: "Decisions",
				entries: [{ body: "Use a small Lit app.", contentHash: "entry-hash", createdAt: "2026-09-04T00:00:00.000Z", createdBy: "user", id: "entry-1", planId: "plan-1", reference: "PLAN_ENTRY_123", referencedEntityIds: [], revision: 1, role: "decision", scopeDirection: null, shortReference: "PLAN_ENTRY_123", supersededEntryIds: [], tombstone: false, updatedAt: "2026-09-04T00:00:00.000Z", updatedBy: "user" }]
			}
		],
		hasActiveQuestions: false,
		snapshotDigest: "a".repeat(64),
		status: "in-progress"
	};
}

describe("PlanPreviewApp", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("renders a Proposed Plan as a grouped review document", async () => {
		const element = document.createElement("plan-preview-app") as HTMLElement & { plan: ProposedPlan & { status: string }; updateComplete: Promise<unknown> };
		element.plan = proposedPlan();
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("h1")?.textContent).toContain("Plan Preview Design");
		expect(element.shadowRoot?.querySelector("[data-section=goal]")?.textContent).toContain("Review the Plan before it becomes ready.");
		expect(element.shadowRoot?.querySelector("[data-section=context]")?.textContent).toContain("Use the MCP Apps contract.");
		expect(element.shadowRoot?.querySelector("[data-group=decisions]")?.textContent).toContain("Use a small Lit app.");
		expect(element.shadowRoot?.querySelector("[data-group=questions]")).toBeNull();
	});

	it("shows a read-only ready state without review actions", async () => {
		const element = document.createElement("plan-preview-app") as HTMLElement & { plan: ProposedPlan & { status: string }; updateComplete: Promise<unknown> };
		element.plan = { ...proposedPlan(), status: "ready" };
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("[data-state=ready]")?.textContent).toContain("Plan ready");
		expect(element.shadowRoot?.querySelector("button")).toBeNull();
	});
});