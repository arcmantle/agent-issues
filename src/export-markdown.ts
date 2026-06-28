import type { ContextDetails } from "./context-store.js";
import type { DatabaseSnapshot, HandoffRecord, InitiativeBundle } from "./store.js";
import type { EntityRecord, RelationRecord } from "./domain.js";

export type InitiativeMarkdownExport = {
	bundle: InitiativeBundle;
	context: ContextDetails;
	relations: RelationRecord[];
};

type InitiativeRenderOptions = {
	includeFrontmatter?: boolean;
	headingLevel?: 1 | 2;
};

export type ProjectMarkdownExport = {
	snapshot: DatabaseSnapshot;
	handoffs: HandoffRecord[];
};

export function renderInitiativeMarkdownExport(
	input: InitiativeMarkdownExport,
	options: InitiativeRenderOptions = {}
): string {
	const { bundle, context, relations } = input;
	const includeFrontmatter = options.includeFrontmatter ?? true;
	const headingLevel = options.headingLevel ?? 1;
	const entityIds = collectBundleEntityIds(bundle);
	const bundleRelations = relations.filter(
		(relation) => entityIds.has(relation.fromId) && entityIds.has(relation.toId)
	);
	const frontmatter = {
		type: "initiative-export",
		initiative: summarizeEntity(bundle.initiative),
		counts: {
			prds: bundle.prds.length,
			userStories: bundle.userStories.length,
			adrs: bundle.adrs.length,
			issues: bundle.issues.length,
			handoffs: bundle.handoffs.length,
			relations: bundleRelations.length
		},
		connections: summarizeRelations(bundleRelations),
		context: summarizeContext(context),
		generatedAt: new Date().toISOString()
	};

	const sections = [
		includeFrontmatter ? renderFrontmatter(frontmatter) : "",
		renderEntitySection(bundle.initiative, headingLevel),
		renderContextSection(context, headingLevel + 1),
		renderEntityCollection("PRDs", bundle.prds, headingLevel + 1),
		renderEntityCollection("User Stories", bundle.userStories, headingLevel + 1),
		renderEntityCollection("ADRs", bundle.adrs, headingLevel + 1),
		renderEntityCollection("Issues", bundle.issues, headingLevel + 1),
		renderRelationsSection("Relations", bundleRelations, headingLevel + 1),
		renderHandoffsSection(bundle.handoffs, headingLevel + 1)
	];

	return sections
		.filter((section) => section.length > 0)
		.join("\n\n");
}

export function renderProjectMarkdownExport(input: ProjectMarkdownExport): string {
	const { snapshot, handoffs } = input;
	const frontmatter = {
		type: "project-export",
		generatedAt: snapshot.generatedAt,
		counts: {
			entities: snapshot.entities.length,
			relations: snapshot.relations.length,
			initiatives: snapshot.initiatives.length,
			projectAdrs: snapshot.projectAdrs.length,
			orphans: snapshot.orphans.length,
			handoffs: handoffs.length
		},
		connections: summarizeRelations(snapshot.relations),
		sharedContext: summarizeContext(snapshot.contexts.shared)
	};

	const initiativeSections = snapshot.initiatives.map((bundle) => {
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === bundle.initiative.id) ?? emptyInitiativeContext(bundle.initiative);
		return renderInitiativeMarkdownExport({
			bundle,
			context,
			relations: snapshot.relations
		}, {
			includeFrontmatter: false,
			headingLevel: 2
		});
	});

	return [
		renderFrontmatter(frontmatter),
		"# Project Export",
		renderProjectSummary(snapshot),
		renderProjectAdrsSection(snapshot.projectAdrs),
		renderOrphansSection(snapshot.orphans),
		renderProjectHandoffsSection(handoffs),
		initiativeSections.join("\n\n")
	]
		.filter((section) => section.length > 0)
		.join("\n\n");
}

function renderProjectSummary(snapshot: DatabaseSnapshot): string {
	return [
		`Generated at: ${snapshot.generatedAt}`,
		`Initiatives: ${snapshot.initiatives.length}`,
		`Entities: ${snapshot.entities.length}`,
		`Relations: ${snapshot.relations.length}`
	].join("\n");
}

function renderProjectAdrsSection(adrs: EntityRecord[]): string {
	if (adrs.length === 0) {
		return "## Project ADRs\n\nNone.";
	}

	return renderEntityCollection("Project ADRs", adrs, 2);
}

function renderOrphansSection(orphans: EntityRecord[]): string {
	if (orphans.length === 0) {
		return "## Orphans\n\nNone.";
	}

	return renderEntityCollection("Orphans", orphans, 2);
}

function renderProjectHandoffsSection(handoffs: HandoffRecord[]): string {
	if (handoffs.length === 0) {
		return "## Handoffs\n\nNone.";
	}

	const lines = handoffs.map((handoff) => {
		const summary = handoff.summary ? ` - ${handoff.summary}` : "";
		const initiative = handoff.initiativeId ? ` initiative=${handoff.initiativeId}` : "";
		return `- ${handoff.id} entity=${handoff.entityId}${initiative} created=${handoff.createdAt}${summary}`;
	});

	return [`## Handoffs`, ...lines].join("\n");
}

function renderEntitySection(entity: EntityRecord, level: 1 | 2 | 3): string {
	const header = `${"#".repeat(level)} ${entity.id} ${entity.title}`;
	const metadata = [
		`Kind: ${entity.kind}`,
		`Status: ${entity.status}`,
		`Created: ${entity.createdAt}`,
		`Updated: ${entity.updatedAt}`,
		`Body source: ${entity.bodySource}`
	].join("\n");
	const body = entity.body.trim().length > 0 ? entity.body : "_No body._";

	return [header, metadata, body].join("\n\n");
}

function renderEntityCollection(title: string, entities: EntityRecord[], headingLevel: number): string {
	if (entities.length === 0) {
		return `${"#".repeat(headingLevel)} ${title}\n\nNone.`;
	}

	return [`${"#".repeat(headingLevel)} ${title}`, ...entities.map((entity) => renderEntitySection(entity, 3))].join("\n\n");
}

function renderRelationsSection(title: string, relations: RelationRecord[], headingLevel: number): string {
	if (relations.length === 0) {
		return `${"#".repeat(headingLevel)} ${title}\n\nNone.`;
	}

	const lines = relations.map(
		(relation) => `- ${relation.fromId} --${relation.type}--> ${relation.toId} created=${relation.createdAt}`
	);

	return [`${"#".repeat(headingLevel)} ${title}`, ...lines].join("\n");
}

function renderHandoffsSection(handoffs: HandoffRecord[], headingLevel: number): string {
	if (handoffs.length === 0) {
		return `${"#".repeat(headingLevel)} Handoffs\n\nNone.`;
	}

	const sections = handoffs.map((handoff) => {
		const summary = handoff.summary.trim().length > 0 ? handoff.summary : "Untitled handoff";
		return [`${"#".repeat(headingLevel + 1)} ${handoff.id} ${summary}`, `Entity: ${handoff.entityId}`, `Created: ${handoff.createdAt}`, handoff.body].join("\n\n");
	});

	return [`${"#".repeat(headingLevel)} Handoffs`, ...sections].join("\n\n");
}

function renderContextSection(context: ContextDetails, headingLevel: number): string {
	const header = `${"#".repeat(headingLevel)} Context`;
	const metadata = [
		`Scope: ${context.context.scopeKind}`,
		`Label: ${context.context.scopeLabel}`,
		`Title: ${context.context.title}`,
		`Summary: ${context.context.summary}`
	].join("\n");

	if (context.terms.length === 0) {
		return [header, metadata, "No terms."].join("\n\n");
	}

	const terms = context.terms.map((term) => {
		const avoid = term.avoid.length > 0 ? ` Avoid: ${term.avoid.join(", ")}.` : "";
		return `- ${term.term}: ${term.definition}.${avoid}`;
	});

	return [header, metadata, `${"#".repeat(headingLevel + 1)} Terms`, ...terms].join("\n\n");
}

function summarizeEntity(entity: EntityRecord) {
	return {
		id: entity.id,
		kind: entity.kind,
		status: entity.status,
		title: entity.title
	};
}

function summarizeRelations(relations: RelationRecord[]) {
	return relations.map((relation) => ({
		from: relation.fromId,
		type: relation.type,
		to: relation.toId,
		createdAt: relation.createdAt
	}));
}

function summarizeContext(context: ContextDetails) {
	return {
		key: context.context.key,
		scopeKind: context.context.scopeKind,
		scopeEntityId: context.context.scopeEntityId,
		scopeLabel: context.context.scopeLabel,
		title: context.context.title,
		summary: context.context.summary,
		termCount: context.terms.length,
		terms: context.terms.map((term) => ({
			term: term.term,
			definition: term.definition,
			avoid: term.avoid
		}))
	};
}

export function renderFrontmatter(value: unknown): string {
	return `---\n${toYaml(value, 0)}---`;
}

function toYaml(value: unknown, indent: number): string {
	const prefix = " ".repeat(indent);

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${prefix}[]\n`;
		}

		return value
			.map((entry) => {
				if (isScalar(entry)) {
					return `${prefix}- ${formatScalar(entry)}\n`;
				}

				const nested = toYaml(entry, indent + 2);
				return `${prefix}-\n${nested}`;
			})
			.join("");
	}

	if (isPlainObject(value)) {
		return Object.entries(value)
			.map(([key, entry]) => {
				if (isScalar(entry)) {
					return `${prefix}${key}: ${formatScalar(entry)}\n`;
				}

				if (Array.isArray(entry) && entry.length === 0) {
					return `${prefix}${key}: []\n`;
				}

				return `${prefix}${key}:\n${toYaml(entry, indent + 2)}`;
			})
			.join("");
	}

	return `${prefix}${formatScalar(value)}\n`;
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (value === null) {
		return "null";
	}

	return JSON.stringify(String(value));
}

function isScalar(value: unknown): value is string | number | boolean | null {
	return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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