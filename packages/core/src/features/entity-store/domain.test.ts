import { describe, expect, it } from "vitest";

import { deriveEntityStatuses, derivePrdStatus, isAllowedRelation, isInitiativeComplete, isValidStatus } from "./domain.js";

describe("superseded planning records", () => {
	it("allows ADRs to be recorded by projects, epics, and initiatives", () => {
		expect(isAllowedRelation("project", "adr", "records")).toBe(true);
		expect(isAllowedRelation("epic", "adr", "records")).toBe(true);
		expect(isAllowedRelation("initiative", "adr", "records")).toBe(true);
	});

	it("allows superseded as a derived PRD and user-story status", () => {
		expect(isValidStatus("prd", "superseded")).toBe(true);
		expect(isValidStatus("userStory", "superseded")).toBe(true);
		expect(isAllowedRelation("prd", "prd", "supersedes")).toBe(true);
		expect(isAllowedRelation("userStory", "userStory", "supersedes")).toBe(true);
	});

	it("derives superseded only from an incoming supersedes relation", () => {
		const entities = [
			{ id: "PRD1", reference: "PRD1", createdBy: "user", updatedBy: "user", kind: "prd" as const, title: "Old", status: "draft", body: "", bodySource: "authored" as const, revision: 1, contentHash: "", createdAt: "", updatedAt: "" },
			{ id: "PRD2", reference: "PRD2", createdBy: "user", updatedBy: "user", kind: "prd" as const, title: "New", status: "draft", body: "", bodySource: "authored" as const, revision: 1, contentHash: "", createdAt: "", updatedAt: "" },
			{ id: "US1", reference: "US1", createdBy: "user", updatedBy: "user", kind: "userStory" as const, title: "Old", status: "draft", body: "", bodySource: "authored" as const, revision: 1, contentHash: "", createdAt: "", updatedAt: "" },
			{ id: "US2", reference: "US2", createdBy: "user", updatedBy: "user", kind: "userStory" as const, title: "New", status: "draft", body: "", bodySource: "authored" as const, revision: 1, contentHash: "", createdAt: "", updatedAt: "" }
		];
		const relations = [
			{ fromId: "PRD2", toId: "PRD1", type: "supersedes" as const, createdBy: "user", createdAt: "" },
			{ fromId: "US2", toId: "US1", type: "supersedes" as const, createdBy: "user", createdAt: "" }
		];

		const statuses = new Map(deriveEntityStatuses(entities, relations).map((entity) => [entity.id, entity.status]));
		expect(statuses.get("PRD1")).toBe("superseded");
		expect(statuses.get("US1")).toBe("superseded");
		expect(statuses.get("PRD2")).toBe("draft");
		expect(statuses.get("US2")).toBe("draft");
	});

	it("treats superseded planning children as terminal", () => {
		expect(derivePrdStatus("draft", ["done", "superseded"])).toBe("approved");
		expect(derivePrdStatus("draft", ["superseded", "superseded"])).toBe("approved");
		expect(isInitiativeComplete(["done"], ["approved", "superseded"])).toBe(true);
	});
});