import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEntity, ensureDatabase } from "@agent-issues/api-local";
import { startLiveSite } from "./server.js";

const TENANT = "selected-project-routing";

let previousNoDaemon: string | undefined;
let temporaryDirectory: string | null = null;

afterEach(() => {
	if (previousNoDaemon === undefined) {
		delete process.env.AGENT_ISSUES_NO_DAEMON;
	} else {
		process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
	}
	if (temporaryDirectory) {
		rmSync(temporaryDirectory, { force: true, recursive: true });
		temporaryDirectory = null;
	}
});

describe("selected project site routing", () => {
	it("reads and changes the browser-selected project instead of the workspace project", async () => {
		temporaryDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-selected-project-"));
		const workspace = path.join(temporaryDirectory, "workspace-project");
		const dbPath = path.join(temporaryDirectory, "agent-issues.db");
		mkdirSync(workspace);

		const { db, executor } = await ensureDatabase(dbPath, { tenant: TENANT });
		const workspaceProject = createEntity(executor, { kind: "project", title: "workspace-project" });
		const selectedProject = createEntity(executor, { kind: "project", title: "selected-project" });
		db.currentProjectId = workspaceProject.id;
		const workspaceAdr = createEntity(executor, { kind: "adr", title: "Workspace ADR" });
		const workspaceEpic = createEntity(executor, { kind: "epic", parentId: workspaceProject.id, title: "Workspace delivery" });
		const workspaceInitiative = createEntity(executor, { kind: "initiative", parentId: workspaceEpic.id, title: "Workspace initiative" });
		db.currentProjectId = selectedProject.id;
		const selectedAdr = createEntity(executor, { kind: "adr", title: "Selected ADR" });
		const selectedEpic = createEntity(executor, { kind: "epic", parentId: selectedProject.id, title: "Selected delivery" });
		const selectedInitiative = createEntity(executor, { kind: "initiative", parentId: selectedEpic.id, title: "Selected initiative" });
		db.close();

		previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";
		const handle = await startLiveSite({ currentWorkingDirectory: workspace, dbPath, port: 0, tenant: TENANT });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const adrSection = await fetch(`${baseUrl}/api/project-adrs?tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json()) as {
				projectAdrs: Array<{ id: string }>;
			};
			expect(adrSection.projectAdrs.map((adr) => adr.id)).toEqual([selectedAdr.id]);
			expect(adrSection.projectAdrs.map((adr) => adr.id)).not.toContain(workspaceAdr.id);

			const detail = await fetch(`${baseUrl}/api/initiative-detail?initiative=${selectedInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json()) as {
				initiative: { id: string; title: string };
			};
			expect(detail.initiative).toMatchObject({ id: selectedInitiative.id, title: "Selected initiative" });
			await expect(fetch(`${baseUrl}/api/entity-detail?entity=${workspaceInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });
			await expect(fetch(`${baseUrl}/api/entity-relations?entity=${workspaceInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });
			await expect(fetch(`${baseUrl}/api/initiative-detail?initiative=${workspaceInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });
			await expect(fetch(`${baseUrl}/api/initiative-tab?initiative=${workspaceInitiative.id}&tab=overview&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });

			const mutationResponse = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "selected-project-write",
					method: "updateEntity",
					params: {
						entityId: selectedInitiative.id,
						expectedContentHash: selectedInitiative.contentHash,
						expectedRevision: selectedInitiative.revision,
						title: "Updated selected initiative"
					}
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			const mutation = await mutationResponse.json() as { result: { id: string; title: string } };
			expect(mutation.result).toMatchObject({ id: selectedInitiative.id, title: "Updated selected initiative" });

			const crossProjectMutation = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "cross-project-write",
					method: "updateEntity",
					params: {
						entityId: workspaceInitiative.id,
						expectedContentHash: workspaceInitiative.contentHash,
						expectedRevision: workspaceInitiative.revision,
						title: "Changed through selected project"
					}
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			expect(crossProjectMutation.status).toBe(500);

			const crossProjectCreate = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "cross-project-create",
					method: "createEntity",
					params: { kind: "issue", parentId: workspaceInitiative.id, title: "Wrong project issue" }
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			expect(crossProjectCreate.status).toBe(500);

			const crossProjectRelations = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "cross-project-relations",
					method: "applyRelations",
					params: {
						relations: [{ fromId: selectedInitiative.id, toId: workspaceInitiative.id, type: "supersedes" }]
					}
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			expect(crossProjectRelations.status).toBe(500);

			const workspaceDetail = await fetch(`${baseUrl}/api/initiative-detail?initiative=${workspaceInitiative.id}&tenant=${TENANT}&project=${workspaceProject.id}`).then((response) => response.json()) as {
				initiative: { title: string };
			};
			expect(workspaceDetail.initiative.title).toBe("Workspace initiative");
		} finally {
			const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closePromise;
		}
	});
});