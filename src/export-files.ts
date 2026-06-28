import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ContextDetails } from "./context-store.js";
import type { EntityRecord, RelationRecord } from "./domain.js";
import { renderFrontmatter, renderInitiativeMarkdownExport, renderProjectMarkdownExport } from "./export-markdown.js";
import type { DatabaseSnapshot, HandoffRecord, InitiativeBundle } from "./store.js";

export type DirectoryExportResult = {
	mode: "directory";
	scope: "initiative" | "project";
	outputPath: string;
	files: string[];
};

export function writeInitiativeDirectoryExport(input: {
	bundle: InitiativeBundle;
	context: ContextDetails;
	outputPath: string;
	relations: RelationRecord[];
	force?: boolean;
}): DirectoryExportResult {
	prepareOutputDirectory(input.outputPath, input.force ?? false);

	const files: string[] = [];
	const entityIds = collectBundleEntityIds(input.bundle);
	const scopedRelations = input.relations.filter(
		(relation) => entityIds.has(relation.fromId) && entityIds.has(relation.toId)
	);

	writeMarkdownFile(
		input.outputPath,
		"initiative.md",
		renderInitiativeMarkdownExport(
			{
				bundle: input.bundle,
				context: input.context,
				relations: input.relations
			},
			{ includeFrontmatter: true, headingLevel: 1 }
		),
		files
	);
	writeMarkdownFile(input.outputPath, "context.md", renderContextMarkdown(input.context), files);
	writeEntityGroup(input.outputPath, "prds", input.bundle.prds, scopedRelations, files);
	writeEntityGroup(input.outputPath, "user-stories", input.bundle.userStories, scopedRelations, files);
	writeEntityGroup(input.outputPath, "adrs", input.bundle.adrs, scopedRelations, files);
	writeEntityGroup(input.outputPath, "issues", input.bundle.issues, scopedRelations, files);
	writeHandoffGroup(input.outputPath, input.bundle.handoffs, files);
	writeRelationGroups(input.outputPath, scopedRelations, files);

	return {
		mode: "directory",
		scope: "initiative",
		outputPath: path.resolve(input.outputPath),
		files: files.sort((left, right) => left.localeCompare(right))
	};
}

export function writeProjectDirectoryExport(input: {
	snapshot: DatabaseSnapshot;
	handoffs: HandoffRecord[];
	outputPath: string;
	force?: boolean;
}): DirectoryExportResult {
	prepareOutputDirectory(input.outputPath, input.force ?? false);

	const files: string[] = [];

	writeMarkdownFile(input.outputPath, "project.md", renderProjectMarkdownExport(input), files);
	writeMarkdownFile(input.outputPath, "shared-context.md", renderContextMarkdown(input.snapshot.contexts.shared), files);
	writeEntityGroup(input.outputPath, "project-adrs", input.snapshot.projectAdrs, input.snapshot.relations, files);
	writeEntityGroup(input.outputPath, "orphans", input.snapshot.orphans, input.snapshot.relations, files);
	writeHandoffGroup(input.outputPath, input.handoffs, files);
	writeRelationGroups(input.outputPath, input.snapshot.relations, files);

	const initiativesRoot = path.join(input.outputPath, "initiatives");
	mkdirSync(initiativesRoot, { recursive: true });
	for (const bundle of input.snapshot.initiatives) {
		const context = input.snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === bundle.initiative.id) ?? emptyInitiativeContext(bundle.initiative);
		const initiativeDir = path.join(initiativesRoot, bundle.initiative.id);
		const initiativeResult = writeInitiativeDirectoryExport({
			bundle,
			context,
			outputPath: initiativeDir,
			relations: input.snapshot.relations,
			force: true
		});
		files.push(...initiativeResult.files);
	}

	return {
		mode: "directory",
		scope: "project",
		outputPath: path.resolve(input.outputPath),
		files: [...new Set(files)].sort((left, right) => left.localeCompare(right))
	};
}

function renderEntityMarkdown(entity: EntityRecord, relations: RelationRecord[]): string {
	const directIncoming = relations.filter((relation) => relation.toId === entity.id);
	const directOutgoing = relations.filter((relation) => relation.fromId === entity.id);
	const frontmatter = {
		id: entity.id,
		kind: entity.kind,
		status: entity.status,
		title: entity.title,
		bodySource: entity.bodySource,
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
		incomingConnections: directIncoming.map(summarizeRelation),
		outgoingConnections: directOutgoing.map(summarizeRelation)
	};
	const body = entity.body.trim().length > 0 ? entity.body : "_No body._";

	return [
		renderFrontmatter(frontmatter),
		`# ${entity.id} ${entity.title}`,
		`Kind: ${entity.kind}`,
		`Status: ${entity.status}`,
		body
	].join("\n\n");
}

function renderContextMarkdown(context: ContextDetails): string {
	const frontmatter = {
		key: context.context.key,
		scopeKind: context.context.scopeKind,
		scopeEntityId: context.context.scopeEntityId,
		scopeLabel: context.context.scopeLabel,
		title: context.context.title,
		summary: context.context.summary,
		termCount: context.terms.length
	};
	const termLines = context.terms.length === 0
		? ["No terms."]
		: context.terms.map((term) => `- ${term.term}: ${term.definition}${term.avoid.length > 0 ? ` Avoid: ${term.avoid.join(", ")}.` : ""}`);

	return [renderFrontmatter(frontmatter), `# ${context.context.title}`, context.context.summary || "No summary.", "## Terms", ...termLines].join("\n\n");
}

function renderHandoffMarkdown(handoff: HandoffRecord): string {
	const frontmatter = {
		id: handoff.id,
		entityId: handoff.entityId,
		initiativeId: handoff.initiativeId,
		summary: handoff.summary,
		createdAt: handoff.createdAt
	};
	const heading = handoff.summary.trim().length > 0 ? handoff.summary : handoff.id;

	return [renderFrontmatter(frontmatter), `# ${heading}`, `Entity: ${handoff.entityId}`, handoff.body].join("\n\n");
}

function renderRelationGroupMarkdown(relationType: string, relations: RelationRecord[]): string {
	const frontmatter = {
		relationType,
		edgeCount: relations.length,
		edges: relations.map(summarizeRelation)
	};
	const lines = relations.length === 0
		? ["None."]
		: relations.map((relation) => `- ${relation.fromId} -> ${relation.toId} (${relation.createdAt})`);

	return [renderFrontmatter(frontmatter), `# ${relationType}`, ...lines].join("\n\n");
}

function writeEntityGroup(rootPath: string, groupName: string, entities: EntityRecord[], relations: RelationRecord[], files: string[]) {
	if (entities.length === 0) {
		return;
	}

	for (const entity of entities) {
		writeMarkdownFile(rootPath, path.join(groupName, `${entity.id}.md`), renderEntityMarkdown(entity, relations), files);
	}
}

function writeHandoffGroup(rootPath: string, handoffs: HandoffRecord[], files: string[]) {
	if (handoffs.length === 0) {
		return;
	}

	for (const handoff of handoffs) {
		writeMarkdownFile(rootPath, path.join("handoffs", `${handoff.id}.md`), renderHandoffMarkdown(handoff), files);
	}
}

function writeRelationGroups(rootPath: string, relations: RelationRecord[], files: string[]) {
	const grouped = new Map<string, RelationRecord[]>();

	for (const relation of relations) {
		const existing = grouped.get(relation.type);
		if (existing) {
			existing.push(relation);
		} else {
			grouped.set(relation.type, [relation]);
		}
	}

	for (const [relationType, groupedRelations] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
		writeMarkdownFile(rootPath, path.join("relations", `${relationType}.md`), renderRelationGroupMarkdown(relationType, groupedRelations), files);
	}
}

function writeMarkdownFile(rootPath: string, relativePath: string, content: string, files: string[]) {
	const absolutePath = path.join(rootPath, relativePath);
	mkdirSync(path.dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, `${content.trimEnd()}\n`, "utf8");
	files.push(path.resolve(absolutePath));
}

function prepareOutputDirectory(outputPath: string, force: boolean) {
	const resolvedPath = path.resolve(outputPath);
	if (existsSync(resolvedPath)) {
		if (!force) {
			throw new Error(`Export output already exists: ${resolvedPath}. Use --force to replace it.`);
		}

		rmSync(resolvedPath, { force: true, recursive: true });
	}

	mkdirSync(resolvedPath, { recursive: true });
}

function summarizeRelation(relation: RelationRecord) {
	return {
		from: relation.fromId,
		type: relation.type,
		to: relation.toId,
		createdAt: relation.createdAt
	};
}

function collectBundleEntityIds(bundle: InitiativeBundle): Set<string> {
	return new Set([
		bundle.initiative.id,
		...bundle.prds.map((entity) => entity.id),
		...bundle.userStories.map((entity) => entity.id),
		...bundle.adrs.map((entity) => entity.id),
		...bundle.issues.map((entity) => entity.id)
	]);
}

function emptyInitiativeContext(initiative: EntityRecord): ContextDetails {
	return {
		context: {
			key: initiative.id,
			scopeKind: "initiative",
			scopeEntityId: initiative.id,
			scopeLabel: initiative.title,
			title: `${initiative.title} Context`,
			summary: "",
			createdAt: null,
			updatedAt: null,
			exists: false
		},
		terms: []
	};
}