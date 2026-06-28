import type { installAgent, listAgent, uninstallAgent } from "../agent-installer.js";
import type { BackfillBodiesResult, BackfillableBodyKind } from "../body-backfill.js";
import type { listTenants } from "../database.js";
import type { startLiveSite } from "../site/index.js";
import type { installSkills, listSkills, uninstallSkills } from "../skill-installer.js";
import type { createHandoff, deleteHandoff, getHandoffDetails, updateHandoff } from "../store.js";

export function renderEntityList(kind: string, entities: Array<{ id: string; status: string; title: string }>): string {
	if (entities.length === 0) {
		return `No ${kind} entities found.`;
	}

	return entities.map((entity) => `${entity.id} ${entity.status} ${entity.title}`).join("\n");
}

export function renderOptionalEntityList(
	label: string,
	entities: Array<{ id: string; kind: string; status: string; title: string }>
): string {
	if (entities.length === 0) {
		return `No ${label} entities found.`;
	}

	return entities.map((entity) => `${entity.id} ${entity.kind} ${entity.status} ${entity.title}`).join("\n");
}

export function renderEntityDetails(details: {
	entity: { id: string; kind: string; status: string; title: string };
	incoming: Array<{ relationType: string; entity: { id: string; kind: string; status: string } }>;
	outgoing: Array<{ relationType: string; entity: { id: string; kind: string; status: string } }>;
}): string {
	const incoming = details.incoming.length
		? details.incoming.map((link) => `${link.entity.id} ${link.entity.kind} --${link.relationType}--> ${details.entity.id}`).join("\n")
		: "none";
	const outgoing = details.outgoing.length
		? details.outgoing.map((link) => `${details.entity.id} --${link.relationType}--> ${link.entity.id} ${link.entity.kind}`).join("\n")
		: "none";

	return [
		`${details.entity.id} ${details.entity.kind} ${details.entity.status} ${details.entity.title}`,
		"Incoming:",
		incoming,
		"Outgoing:",
		outgoing
	].join("\n");
}

export function renderInitiativeBundle(bundle: {
	initiative: { id: string; status: string; title: string };
	prds: Array<{ id: string; status: string }>;
	userStories: Array<{ id: string; status: string }>;
	adrs: Array<{ id: string; status: string }>;
	issues: Array<{ id: string; status: string }>;
	fixLinks: Array<{ issue: { id: string }; userStory: { id: string } }>;
	subIssueLinks: Array<{ parent: { id: string }; issue: { id: string } }>;
	blockerLinks: Array<{ source: { id: string }; target: { id: string } }>;
	constrainsLinks: Array<{ adr: { id: string }; issue: { id: string } }>;
}): string {
	return [
		`${bundle.initiative.id} ${bundle.initiative.status} ${bundle.initiative.title}`,
		`PRDs: ${renderCompactList(bundle.prds)}`,
		`User Stories: ${renderCompactList(bundle.userStories)}`,
		`ADRs: ${renderCompactList(bundle.adrs)}`,
		`Issues: ${renderCompactList(bundle.issues)}`,
		`Fixes: ${bundle.fixLinks.length ? bundle.fixLinks.map((link) => `${link.issue.id} -> ${link.userStory.id}`).join(", ") : "none"}`,
		`Sub-issues: ${bundle.subIssueLinks.length ? bundle.subIssueLinks.map((link) => `${link.parent.id} -> ${link.issue.id}`).join(", ") : "none"}`,
		`Blockers: ${bundle.blockerLinks.length ? bundle.blockerLinks.map((link) => `${link.source.id} -> ${link.target.id}`).join(", ") : "none"}`,
		`Constrains: ${bundle.constrainsLinks.length ? bundle.constrainsLinks.map((link) => `${link.adr.id} -> ${link.issue.id}`).join(", ") : "none"}`
	].join("\n");
}

export function renderHandoffDetails(handoff: ReturnType<typeof getHandoffDetails>): string {
	const lines = [`Focus: ${renderEntityLine(handoff.focus.entity)}`];

	lines.push("Path:");
	if (handoff.structuralPath.length === 0) {
		lines.push("none");
	} else {
		for (const entry of handoff.structuralPath) {
			lines.push(`${entry.relationType} ${renderEntityLine(entry.entity)}`);
		}
	}

	lines.push(`Orphaned: ${handoff.orphaned ? "yes" : "no"}`);

	lines.push("Active blockers:");
	if (handoff.activeBlockers.length === 0) {
		lines.push("none");
	} else {
		for (const blocker of handoff.activeBlockers) {
			lines.push(renderEntityLine(blocker));
		}
	}

	lines.push(
		handoff.initiative
			? `Initiative: ${renderEntityLine(handoff.initiative.initiative)}`
			: "Initiative: none"
	);

	if (handoff.initiative) {
		lines.push(
			`Bundle: prds=${handoff.initiative.prds.length} stories=${handoff.initiative.userStories.length} adrs=${handoff.initiative.adrs.length} issues=${handoff.initiative.issues.length}`
		);
	}

	lines.push("Saved handoffs:");
	if (handoff.handoffs.length === 0) {
		lines.push("none");
	} else {
		for (const saved of handoff.handoffs) {
			lines.push(`${saved.id} ${saved.createdAt}${saved.summary ? ` ${saved.summary}` : ""}`);
		}
	}

	lines.push("Relations:");
	lines.push(indentBlock(renderEntityDetails(handoff.focus)));

	return lines.join("\n");
}

export function renderHandoffCreateResult(handoff: ReturnType<typeof createHandoff>): string {
	const scope = handoff.initiativeId ? `initiative ${handoff.initiativeId}` : "no initiative";
	const label = handoff.summary ? ` ${handoff.summary}` : "";
	return `Saved handoff ${handoff.id} for ${handoff.entityId} (${scope})${label}`;
}

export function renderHandoffEditResult(handoff: ReturnType<typeof updateHandoff>): string {
	const scope = handoff.initiativeId ? `initiative ${handoff.initiativeId}` : "no initiative";
	const label = handoff.summary ? ` ${handoff.summary}` : "";
	return `Updated handoff ${handoff.id} for ${handoff.entityId} (${scope})${label}`;
}

export function renderHandoffDeleteResult(result: ReturnType<typeof deleteHandoff>): string {
	const scope = result.handoff.initiativeId ? `initiative ${result.handoff.initiativeId}` : "no initiative";
	const label = result.handoff.summary ? ` ${result.handoff.summary}` : "";
	return `Deleted handoff ${result.handoff.id} for ${result.handoff.entityId} (${scope})${label}`;
}

export function renderInstallSkills(result: ReturnType<typeof installSkills>): string {
	const lines = [`Installed skills to ${result.targetDir}`];

	for (const item of result.installed) {
		lines.push(`${item.installedName} ${item.status} ${item.destinationDir}`);
	}

	return lines.join("\n");
}

export function renderInstallAgent(result: ReturnType<typeof installAgent>): string {
	return [
		`Installed agent to ${result.targetDir}`,
		`${result.installed.installedName} ${result.installed.status} ${result.installed.agentFile}`,
		`hook ${result.installed.hookFile}`
	].join("\n");
}

export function renderListSkills(result: ReturnType<typeof listSkills>): string {
	const lines = [`Packaged skills in ${result.targetDir}`];

	for (const item of result.skills) {
		lines.push(`${item.installedName} ${item.status} ${item.destinationDir}`);
	}

	return lines.join("\n");
}

export function renderListAgent(result: ReturnType<typeof listAgent>): string {
	return [
		`Packaged agent in ${result.targetDir}`,
		`${result.agent.installedName} ${result.agent.status} ${result.agent.agentFile}`,
		`hook ${result.agent.hookFile}`
	].join("\n");
}

export function renderUninstallSkills(result: ReturnType<typeof uninstallSkills>): string {
	const lines = [`Removed skills from ${result.targetDir}`];

	for (const item of result.removed) {
		lines.push(`${item.installedName} ${item.status} ${item.destinationDir}`);
	}

	return lines.join("\n");
}

export function renderUninstallAgent(result: ReturnType<typeof uninstallAgent>): string {
	return [
		`Removed agent from ${result.targetDir}`,
		`${result.removed.installedName} ${result.removed.status} ${result.removed.agentFile}`,
		`hook ${result.removed.hookFile}`
	].join("\n");
}

export function renderCurrentTenant(result: {
	command: "current-tenant";
	dbPath: string;
	resolution: "derived" | "explicit";
	tenantId: string;
	workspaceRoot: string;
}): string {
	return [
		`Current tenant: ${result.tenantId}`,
		`Resolution: ${result.resolution}`,
		`Workspace root: ${result.workspaceRoot}`,
		`Database: ${result.dbPath}`
	].join("\n");
}

export function renderTenantList(result: {
	command: "list-tenants";
	currentTenantId: string;
	dbPath: string;
	tenants: ReturnType<typeof listTenants>;
}): string {
	const lines = [`Tenants in ${result.dbPath}`];

	if (result.tenants.length === 0) {
		lines.push("none");
		return lines.join("\n");
	}

	for (const tenant of result.tenants) {
		const marker = tenant.id === result.currentTenantId ? "*" : "-";
		lines.push(
			`${marker} ${tenant.id} (${tenant.displayName}) entities=${tenant.counts.entities} relations=${tenant.counts.relations} contexts=${tenant.counts.contexts} terms=${tenant.counts.contextTerms} handoffs=${tenant.counts.handoffs}`
		);
	}

	return lines.join("\n");
}

export function renderDeleteTenant(result: {
	command: "delete-tenant";
	dbPath: string;
	tenantId: string;
	displayName: string;
	removed: boolean;
	counts: {
		entities: number;
		relations: number;
		contexts: number;
		contextTerms: number;
		handoffs: number;
	};
	counters: number;
}): string {
	if (!result.removed) {
		return `Tenant not found: ${result.tenantId}`;
	}

	return [
		`Deleted tenant ${result.tenantId} (${result.displayName})`,
		`Database: ${result.dbPath}`,
		`Removed rows: entities=${result.counts.entities} relations=${result.counts.relations} contexts=${result.counts.contexts} terms=${result.counts.contextTerms} handoffs=${result.counts.handoffs} counters=${result.counters}`
	].join("\n");
}

export function renderRenameTenant(result: {
	command: "rename-tenant";
	dbPath: string;
	previousTenantId: string;
	previousDisplayName: string;
	newTenantId: string;
	newDisplayName: string;
	renamed: boolean;
	counts: {
		entities: number;
		relations: number;
		contexts: number;
		contextTerms: number;
		handoffs: number;
	};
	counters: number;
}): string {
	if (!result.renamed) {
		return `Tenant not found: ${result.previousTenantId}`;
	}

	return [
		`Renamed tenant ${result.previousTenantId} (${result.previousDisplayName}) to ${result.newTenantId} (${result.newDisplayName})`,
		`Database: ${result.dbPath}`,
		`Moved rows: entities=${result.counts.entities} relations=${result.counts.relations} contexts=${result.counts.contexts} terms=${result.counts.contextTerms} handoffs=${result.counts.handoffs} counters=${result.counters}`
	].join("\n");
}

export function renderLiveSite(result: ReturnType<typeof startLiveSite>["info"], opened: boolean): string {
	return [
		`${opened ? "Opened" : "Serving"} live site at ${result.url}`,
		`Database: ${result.dbPath}`,
		`Port: ${result.port}`,
		opened
			? "Browser launch requested; keep this process running to continue listening for database changes."
			: "Keep this process running to continue listening for database changes."
	].join("\n");
}

export function renderStopLiveSite(result: { host: string; port: number; url: string; reachable: boolean; stopped: boolean }): string {
	if (!result.stopped) {
		if (result.reachable) {
			return `A server is listening at ${result.url}, but it does not expose the agent-issues stop endpoint.`;
		}

		return `No live site was running at ${result.url}`;
	}

	return `Stopped live site at ${result.url}`;
}

export function renderBackfillBodies(result: {
	command: "backfill-bodies";
	dbPath: string;
	dryRun: boolean;
	force: boolean;
	kinds: BackfillableBodyKind[];
	scope: "current-tenant" | "all-tenants";
	tenants: BackfillBodiesResult[];
}): string {
	const lines = [
		`${result.dryRun ? "Previewed" : "Backfilled"} bodies in ${result.scope === "all-tenants" ? "all tenants" : "the current tenant"}`,
		`Database: ${result.dbPath}`,
		`Kinds: ${result.kinds.join(", ")}`,
		`Dry run: ${result.dryRun ? "yes" : "no"}`,
		`Force overwrite: ${result.force ? "yes" : "no"}`
	];

	if (result.tenants.length === 0) {
		lines.push("No tenants were present in the selected database.");
		return lines.join("\n");
	}

	for (const tenant of result.tenants) {
		lines.push(
			"",
			`Tenant ${tenant.tenantId}`,
			`  considered=${tenant.considered} updated=${tenant.updated} skipped=${tenant.skipped}`
		);

		for (const kind of tenant.byKind) {
			lines.push(`  ${kind.kind}: considered=${kind.considered} updated=${kind.updated} skipped=${kind.skipped}`);
		}
	}

	return lines.join("\n");
}

function renderCompactList(entities: Array<{ id: string; status: string }>): string {
	if (entities.length === 0) {
		return "none";
	}

	return entities.map((entity) => `${entity.id}:${entity.status}`).join(", ");
}

function renderEntityLine(entity: { id: string; kind: string; status: string; title: string }): string {
	return `${entity.id} ${entity.kind} ${entity.status} ${entity.title}`;
}

function indentBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}
