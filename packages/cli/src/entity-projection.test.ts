import type { EntityDetails, EntityRecord, InitiativeBundle } from "@agent-issues/core";
import { describe, expect, it } from "vitest";

import { toCompactEntity, toCompactEntityDetails, toCompactEntityList, toCompactInitiativeBundle } from "./entity-projection.js";

const entity: EntityRecord = {
	id: "ISS_01",
	reference: "ISS1",
	shortReference: "ISS1",
	createdBy: "user-1",
	updatedBy: "user-1",
	kind: "issue",
	title: "Define compact projections",
	status: "in-progress",
	body: "Verbose body",
	bodySource: "authored",
	category: null,
	priority: null,
	type: null,
	revision: 3,
	contentHash: "content-hash",
	createdAt: "2026-07-24T10:00:00.000Z",
	updatedAt: "2026-07-24T11:00:00.000Z"
};

const planEntry = {
	id: "PLAN_ENTRY_01",
	reference: "PLAN_ENTRY1",
	shortReference: "PLAN_ENTRY1",
	planId: "PLAN_01",
	createdBy: "user-1",
	updatedBy: "user-1",
	role: "decision" as const,
	body: "Use compact issue details.",
	scopeDirection: null,
	referencedEntityIds: [entity.id],
	supersededEntryIds: [],
	tombstone: false,
	revision: 1,
	contentHash: "plan-entry-hash",
	createdAt: "2026-07-24T10:00:00.000Z",
	updatedAt: "2026-07-24T10:00:00.000Z"
};

describe("compact CLI entity projections", () => {
	it("projects an entity record to exactly its compact fields", () => {
		const compact = toCompactEntity(entity);

		expect(compact).toEqual({
			id: "ISS_01",
			reference: "ISS1",
			kind: "issue",
			status: "in-progress",
			title: "Define compact projections"
		});
		expect(compact).not.toHaveProperty("body");
		expect(compact).not.toHaveProperty("contentHash");
		expect(compact).not.toHaveProperty("revision");
		expect(compact).not.toHaveProperty("createdAt");
		expect(compact).not.toHaveProperty("updatedAt");
	});

	it("projects every details relation to its type and compact neighboring entity", () => {
		const incomingEntity: EntityRecord = {
			...entity,
			id: "ISS_02",
			title: "Incoming issue"
		};
		const outgoingEntity: EntityRecord = {
			...entity,
			id: "US_01",
			kind: "userStory",
			status: "ready",
			title: "Outgoing story"
		};
		const details: EntityDetails = {
			entity,
			incoming: [{ relationType: "blocks", entity: incomingEntity }],
			outgoing: [{ relationType: "fixes", entity: outgoingEntity }],
			planEntries: [planEntry]
		};

		const compact = toCompactEntityDetails(details);

		expect(compact).toEqual({
			entity: {
				id: "ISS_01",
				reference: "ISS1",
				kind: "issue",
				status: "in-progress",
				title: "Define compact projections"
			},
			incoming: [{
				type: "blocks",
				entity: {
					id: "ISS_02",
					reference: "ISS1",
					kind: "issue",
					status: "in-progress",
					title: "Incoming issue"
				}
			}],
			outgoing: [{
				type: "fixes",
				entity: {
					id: "US_01",
					reference: "ISS1",
					kind: "userStory",
					status: "ready",
					title: "Outgoing story"
				}
			}],
			planEntries: [planEntry]
		});
		expect(compact.incoming[0]).not.toHaveProperty("relationType");
		expect(compact.incoming[0]?.entity).not.toHaveProperty("body");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("contentHash");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("revision");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("createdAt");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("updatedAt");
	});

	it("projects an entity list to exactly compact items and total", () => {
		const secondEntity: EntityRecord = {
			...entity,
			id: "ISS_02",
			title: "Use compact projections"
		};

		const compact = toCompactEntityList([entity, secondEntity]);

		expect(compact).toEqual({
			items: [
				{
					id: "ISS_01",
					reference: "ISS1",
					kind: "issue",
					status: "in-progress",
					title: "Define compact projections"
				},
				{
					id: "ISS_02",
					reference: "ISS1",
					kind: "issue",
					status: "in-progress",
					title: "Use compact projections"
				}
			],
			total: 2
		});
		expect(Object.keys(compact)).toEqual(["items", "total"]);
		expect(compact.items[0]).not.toHaveProperty("body");
		expect(compact.items[0]).not.toHaveProperty("contentHash");
		expect(compact.items[0]).not.toHaveProperty("revision");
		expect(compact.items[0]).not.toHaveProperty("createdAt");
		expect(compact.items[0]).not.toHaveProperty("updatedAt");
	});

	it("projects every initiative bundle entity while preserving its exact keys and link structure", () => {
		const initiative = { ...entity, id: "INIT_01", kind: "initiative" as const, title: "Compact views" };
		const prd = { ...entity, id: "PRD_01", kind: "prd" as const, title: "Projection contract" };
		const story = { ...entity, id: "US_01", kind: "userStory" as const, title: "Read compact JSON" };
		const adr = { ...entity, id: "ADR_01", kind: "adr" as const, title: "Project at CLI boundary" };
		const issue = { ...entity, id: "ISS_01", title: "Wire compact views" };
		const subIssue = { ...entity, id: "ISS_02", title: "Cover bundle links" };
		const bundle: InitiativeBundle = {
			initiative,
			entities: [initiative, prd, story, adr, issue, subIssue],
			prds: [prd],
			userStories: [story],
			adrs: [adr],
			issues: [issue, subIssue],
			fixLinks: [{ issue, userStory: story }],
			subIssueLinks: [{ parent: issue, issue: subIssue }],
			blockerLinks: [{ source: subIssue, target: issue }],
			constrainsLinks: [{ adr, issue }]
		};

		const compact = toCompactInitiativeBundle(bundle);
		const summary = (record: EntityRecord) => ({ id: record.id, reference: record.reference, kind: record.kind, status: record.status, title: record.title });

		expect(compact).toEqual({
			initiative: summary(initiative),
			entities: bundle.entities.map(summary),
			prds: [summary(prd)],
			userStories: [summary(story)],
			adrs: [summary(adr)],
			issues: [summary(issue), summary(subIssue)],
			fixLinks: [{ issue: summary(issue), userStory: summary(story) }],
			subIssueLinks: [{ parent: summary(issue), issue: summary(subIssue) }],
			blockerLinks: [{ source: summary(subIssue), target: summary(issue) }],
			constrainsLinks: [{ adr: summary(adr), issue: summary(issue) }]
		});
		expect(Object.keys(compact)).toEqual(Object.keys(bundle));
		expect(compact.entities.every((record) => !Object.hasOwn(record, "body"))).toBe(true);
	});
});