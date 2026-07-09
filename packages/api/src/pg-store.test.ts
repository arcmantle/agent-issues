import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { PgStore } from "./pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced in tests (Postgres superusers bypass
// RLS unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

describe("PgStore entity lifecycle", () => {
	let adminPool: Pool;
	let appPool: Pool;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
		await appPool.end();
	});

	it("creates a parent-less initiative under the auto-bootstrapped EPIC0 sentinel", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);

		const entity = await store.createEntity({ kind: "initiative", title: "Ship the Postgres gate" });

		expect(entity.id).toBe("INIT1");
		expect(entity.kind).toBe("initiative");
		expect(entity.title).toBe("Ship the Postgres gate");
		expect(entity.status).toBe("draft");

		const details = await store.getEntityDetails(entity.id);
		expect(details.incoming).toEqual([{ relationType: "contains", entity: expect.objectContaining({ id: "EPIC0" }) }]);

		const history = await store.listEntityHistory(entity.id);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			version: 1,
			author: "system",
			title: "Ship the Postgres gate",
			status: "draft",
			parentId: "EPIC0"
		});
	});

	it("lists entities of a kind and records an explicit author on the history entry", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);

		await store.createEntity({ kind: "initiative", title: "First", author: "alice" });
		await store.createEntity({ kind: "initiative", title: "Second" });

		const initiatives = await store.listEntities("initiative");
		expect(initiatives.map((entity) => entity.title)).toEqual(["First", "Second"]);

		const history = await store.listEntityHistory(initiatives[0]!.id);
		expect(history[0]?.author).toBe("alice");
	});

	it("keeps tenants isolated even for a query the app layer forgets to filter by tenant_id", async () => {
		const tenantA = `tenant-${randomUUID()}`;
		const tenantB = `tenant-${randomUUID()}`;
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.createEntity({ kind: "initiative", title: "Tenant A's secret initiative" });
		await storeB.createEntity({ kind: "initiative", title: "Tenant B's secret initiative" });

		// Deliberately a raw, tenant-unfiltered query - the same query shape an
		// app-layer bug could produce. RLS (ADR9, the 0001 migration) must be
		// the backstop that blocks cross-tenant rows even so.
		const client = await appPool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
			const result = await client.query("SELECT title FROM entities WHERE kind = 'initiative'");
			expect(result.rows.map((row: { title: string }) => row.title)).toEqual(["Tenant A's secret initiative"]);
			await client.query("COMMIT");
		} finally {
			client.release();
		}
	});

	it("links and unlinks two entities", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocking issue", parentId: initiative.id });

		const linked = await store.linkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(linked.created).toBe(true);
		expect(linked.relation).toMatchObject({ fromId: issue.id, toId: blocker.id, type: "blocks" });

		const relinked = await store.linkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(relinked.created).toBe(false);

		const unlinked = await store.unlinkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(unlinked.removed).toBe(true);
	});

	it("rejects a self-relation and a disallowed relation type", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });

		await expect(store.linkEntities({ fromId: issue.id, toId: issue.id, relationType: "blocks" })).rejects.toThrow(
			"itself"
		);
		await expect(store.linkEntities({ fromId: issue.id, toId: initiative.id, relationType: "blocks" })).rejects.toThrow(
			"not allowed"
		);
	});

	it("rejects a blocks link that would create a cycle", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issueA = await store.createEntity({ kind: "issue", title: "A", parentId: initiative.id });
		const issueB = await store.createEntity({ kind: "issue", title: "B", parentId: initiative.id });

		await store.linkEntities({ fromId: issueA.id, toId: issueB.id, relationType: "blocks" });

		await expect(store.linkEntities({ fromId: issueB.id, toId: issueA.id, relationType: "blocks" })).rejects.toThrow(
			"cycle"
		);
	});

	it("updates status, sets body, and archives an entity", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });

		const statusUpdate = await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });
		expect(statusUpdate.previousStatus).toBe("todo");
		expect(statusUpdate.entity.status).toBe("in-progress");

		const bodyUpdated = await store.setEntityBody({ entityId: issue.id, body: "Detailed plan." });
		expect(bodyUpdated.body).toBe("Detailed plan.");

		const archived = await store.archiveEntity({ entityId: issue.id });
		expect(archived.entity.status).toBe("done");

		const history = await store.listEntityHistory(issue.id);
		expect(history.map((entry) => entry.status)).toEqual(["todo", "in-progress", "in-progress", "done"]);
	});

	it("rejects setting a userStory's status directly once it has a fixing issue", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
		const story = await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
		const issue = await store.createEntity({ kind: "issue", title: "Fixing issue", parentId: initiative.id });
		await store.linkEntities({ fromId: issue.id, toId: story.id, relationType: "fixes" });

		await expect(store.updateEntityStatus({ entityId: story.id, status: "done" })).rejects.toThrow("derived from its fixing issues");
	});

	it("rejects setting an issue to in-progress while an open sub-issue remains", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const parentIssue = await store.createEntity({ kind: "issue", title: "Parent", parentId: initiative.id });
		const subIssue = await store.createEntity({ kind: "issue", title: "Sub", parentId: initiative.id });
		await store.linkEntities({ fromId: parentIssue.id, toId: subIssue.id, relationType: "decomposes" });

		await expect(store.updateEntityStatus({ entityId: parentIssue.id, status: "in-progress" })).rejects.toThrow(
			"sub-issues remain open"
		);
	});

	it("rejects setting an issue to in-progress while an active blocker remains", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Blocked", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocker", parentId: initiative.id });
		await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });

		await expect(store.updateEntityStatus({ entityId: issue.id, status: "in-progress" })).rejects.toThrow("blocked by");
	});

	it("moves an entity to a new structural parent and rejects a cycle", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiativeA = await store.createEntity({ kind: "initiative", title: "A" });
		const initiativeB = await store.createEntity({ kind: "initiative", title: "B" });
		const issue = await store.createEntity({ kind: "issue", title: "Movable", parentId: initiativeA.id });

		const moved = await store.moveEntity({ entityId: issue.id, newParentId: initiativeB.id });
		expect(moved.previousParentId).toBe(initiativeA.id);
		expect(moved.newParentId).toBe(initiativeB.id);
		expect(moved.relationType).toBe("tracks");

		await expect(store.moveEntity({ entityId: issue.id, newParentId: issue.id })).rejects.toThrow("under itself");
	});

	it("rejects deleting an entity that still has outgoing relations", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Has children", parentId: initiative.id });
		const subIssue = await store.createEntity({ kind: "issue", title: "Sub", parentId: initiative.id });
		await store.linkEntities({ fromId: issue.id, toId: subIssue.id, relationType: "decomposes" });

		await expect(store.deleteEntity({ entityId: issue.id })).rejects.toThrow("outgoing relations");

		const deleted = await store.deleteEntity({ entityId: subIssue.id });
		expect(deleted.removed).toBe(true);
	});

	it("lists orphans, excluding initiatives/ADRs/project/epic and anything reachable from an initiative", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await store.createEntity({ kind: "issue", title: "Tracked issue", parentId: initiative.id });
		const orphanIssue = await store.createEntity({ kind: "issue", title: "Orphan issue" });
		const orphanAdr = await store.createEntity({ kind: "adr", title: "Project-scoped ADR" });

		const orphans = await store.listOrphans();
		expect(orphans.map((entity) => entity.id)).toContain(orphanIssue.id);
		expect(orphans.map((entity) => entity.id)).not.toContain(orphanAdr.id);
		expect(orphans.map((entity) => entity.id)).not.toContain(initiative.id);

		const orphanIssuesOnly = await store.listOrphans("issue");
		expect(orphanIssuesOnly.map((entity) => entity.id)).toEqual([orphanIssue.id]);
	});

	it("lists project-scoped ADRs (not linked from any initiative)", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const initiativeAdr = await store.createEntity({ kind: "adr", title: "Initiative ADR", parentId: initiative.id });
		const projectAdr = await store.createEntity({ kind: "adr", title: "Project ADR" });

		const projectAdrs = await store.listProjectAdrs();
		expect(projectAdrs.map((entity) => entity.id)).toContain(projectAdr.id);
		expect(projectAdrs.map((entity) => entity.id)).not.toContain(initiativeAdr.id);
	});

	it("builds an initiative bundle with prds, stories, issues, adrs, and link groups", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
		const story = await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
		const issue = await store.createEntity({ kind: "issue", title: "Fixing issue", parentId: initiative.id });
		const subIssue = await store.createEntity({ kind: "issue", title: "Sub issue", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocker", parentId: initiative.id });
		const adr = await store.createEntity({ kind: "adr", title: "ADR", parentId: initiative.id });

		await store.linkEntities({ fromId: issue.id, toId: story.id, relationType: "fixes" });
		await store.linkEntities({ fromId: issue.id, toId: subIssue.id, relationType: "decomposes" });
		await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });
		await store.linkEntities({ fromId: adr.id, toId: issue.id, relationType: "constrains" });

		const bundle = await store.getInitiativeBundle(initiative.id);
		expect(bundle.initiative.id).toBe(initiative.id);
		expect(bundle.prds.map((entity) => entity.id)).toEqual([prd.id]);
		expect(bundle.userStories.map((entity) => entity.id)).toEqual([story.id]);
		expect(bundle.issues.map((entity) => entity.id).sort()).toEqual([blocker.id, issue.id, subIssue.id].sort());
		expect(bundle.adrs.map((entity) => entity.id)).toEqual([adr.id]);
		expect(bundle.fixLinks).toEqual([{ issue: expect.objectContaining({ id: issue.id }), userStory: expect.objectContaining({ id: story.id }) }]);
		expect(bundle.subIssueLinks).toEqual([{ parent: expect.objectContaining({ id: issue.id }), issue: expect.objectContaining({ id: subIssue.id }) }]);
		expect(bundle.blockerLinks).toEqual([{ source: expect.objectContaining({ id: blocker.id }), target: expect.objectContaining({ id: issue.id }) }]);
		expect(bundle.constrainsLinks).toEqual([{ adr: expect.objectContaining({ id: adr.id }), issue: expect.objectContaining({ id: issue.id }) }]);
		expect(bundle.handoffs).toEqual([]);

		await expect(store.getInitiativeBundle(issue.id)).rejects.toThrow("not an initiative");
	});

	it("reads a full tenant snapshot with entities, relations, orphans, project adrs, and initiative bundles", async () => {
		const store = new PgStore(appPool, `tenant-${randomUUID()}`);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await store.createEntity({ kind: "issue", title: "Tracked issue", parentId: initiative.id });
		const orphanAdr = await store.createEntity({ kind: "adr", title: "Project ADR" });

		const snapshot = await store.getDatabaseSnapshot();
		expect(snapshot.entities.map((entity) => entity.id)).toContain(initiative.id);
		expect(snapshot.relations.length).toBeGreaterThan(0);
		expect(snapshot.projectAdrs.map((entity) => entity.id)).toContain(orphanAdr.id);
		expect(snapshot.initiatives.map((bundle) => bundle.initiative.id)).toContain(initiative.id);
		expect(snapshot.contexts.shared.context.exists).toBe(false);
	});

	describe("handoffs", () => {
		it("persists a handoff anchored to the focus entity and its owning initiative", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Add handoff persistence" });

			const handoff = await store.createHandoff({
				entityId: issue.id,
				summary: "Paused mid-refactor",
				body: "## State\n\nStore layer done, UI pending."
			});

			expect(handoff.id).toMatch(/^HO\d+$/);
			expect(handoff.entityId).toBe(issue.id);
			expect(handoff.initiativeId).toBe(initiative.id);
			expect(handoff.summary).toBe("Paused mid-refactor");
			expect(handoff.body).toBe("## State\n\nStore layer done, UI pending.");
		});

		it("resolves the owning initiative when the focus is the initiative itself", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });

			const handoff = await store.createHandoff({ entityId: initiative.id, body: "Initiative-level handoff." });

			expect(handoff.initiativeId).toBe(initiative.id);
		});

		it("rejects an empty handoff body", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });

			await expect(store.createHandoff({ entityId: initiative.id, body: "   " })).rejects.toThrow(/body/i);
		});

		it("lists handoffs for an initiative newest first", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const first = await store.createHandoff({ entityId: initiative.id, body: "First handoff." });
			const second = await store.createHandoff({ entityId: initiative.id, body: "Second handoff." });

			const listed = await store.listHandoffs({ initiativeId: initiative.id });

			expect(listed.map((handoff) => handoff.id)).toEqual([second.id, first.id]);
		});

		it("updates an existing handoff body and summary", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const handoff = await store.createHandoff({ entityId: initiative.id, summary: "Paused mid-refactor", body: "Initial draft." });

			const updated = await store.updateHandoff({ handoffId: handoff.id, summary: "Ready for pickup", body: "Updated draft." });

			expect(updated.id).toBe(handoff.id);
			expect(updated.summary).toBe("Ready for pickup");
			expect(updated.body).toBe("Updated draft.");
		});

		it("allows clearing a handoff summary while preserving the current body", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const handoff = await store.createHandoff({ entityId: initiative.id, summary: "Temporary summary", body: "Resume here." });

			const updated = await store.updateHandoff({ handoffId: handoff.id, summary: "" });

			expect(updated.summary).toBe("");
			expect(updated.body).toBe("Resume here.");
		});

		it("rejects handoff updates that do not supply any mutable fields", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const handoff = await store.createHandoff({ entityId: initiative.id, body: "Resume here." });

			await expect(store.updateHandoff({ handoffId: handoff.id })).rejects.toThrow(/provide/i);
		});

		it("deletes a handoff by id", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const handoff = await store.createHandoff({ entityId: initiative.id, body: "Resume here." });

			const removed = await store.deleteHandoff({ handoffId: handoff.id });

			expect(removed.handoff.id).toBe(handoff.id);
			expect(removed.removed).toBe(true);
			expect(await store.listHandoffs({ initiativeId: initiative.id })).toHaveLength(0);
		});

		it("exposes handoffs in the initiative bundle and snapshot", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Ship it" });
			const handoff = await store.createHandoff({ entityId: issue.id, body: "Resume from the failing test." });

			const bundle = await store.getInitiativeBundle(initiative.id);
			expect(bundle.handoffs.map((entry) => entry.id)).toContain(handoff.id);

			const snapshot = await store.getDatabaseSnapshot();
			const bundled = snapshot.initiatives.find((entry) => entry.initiative.id === initiative.id);
			expect(bundled?.handoffs.map((entry) => entry.id)).toContain(handoff.id);
		});

		it("returns saved handoffs, the owning initiative bundle, and active blockers from getHandoffDetails", async () => {
			const store = new PgStore(appPool, `tenant-${randomUUID()}`);
			const initiative = await store.createEntity({ kind: "initiative", title: "Console Viewer" });
			const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Ship it" });
			const blocker = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Blocker" });
			await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });
			const handoff = await store.createHandoff({ entityId: issue.id, body: "Resume here." });

			const details = await store.getHandoffDetails(issue.id);

			expect(details.handoffs.map((entry) => entry.id)).toContain(handoff.id);
			expect(details.initiative?.initiative.id).toBe(initiative.id);
			expect(details.orphaned).toBe(false);
			expect(details.activeBlockers.map((entity) => entity.id)).toEqual([blocker.id]);
		});

		it("keeps handoffs isolated per tenant even for an unfiltered listHandoffs call", async () => {
			const tenantA = `tenant-${randomUUID()}`;
			const tenantB = `tenant-${randomUUID()}`;
			const storeA = new PgStore(appPool, tenantA);
			const storeB = new PgStore(appPool, tenantB);

			const initiativeA = await storeA.createEntity({ kind: "initiative", title: "Tenant A initiative" });
			await storeA.createHandoff({ entityId: initiativeA.id, body: "Tenant A handoff." });
			const initiativeB = await storeB.createEntity({ kind: "initiative", title: "Tenant B initiative" });

			expect(await storeB.listHandoffs({ initiativeId: initiativeB.id })).toHaveLength(0);
			expect(await storeA.listHandoffs({ initiativeId: initiativeA.id })).toHaveLength(1);
		});
	});
});