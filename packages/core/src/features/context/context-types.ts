/**
 * The context-store result/record contract (ADR13's dialect-agnostic
 * boundary): every `StorageDriver` implementation - SQLite
 * (`@agent-issues/api-local`) and Postgres (`@agent-issues/api`) alike -
 * returns these same shapes, so they live in core rather than either
 * concrete store.
 */

export const DEFAULT_CONTEXT_KEY = "default";
export const DEFAULT_CONTEXT_TITLE = "Shared Context";
export const DEFAULT_CONTEXT_SUMMARY = "Shared glossary of project-specific domain terms and preferred language.";

export type ContextRecord = {
	key: string;
	scopeKind: "default" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	title: string;
	summary: string;
	createdAt: string | null;
	updatedAt: string | null;
	exists: boolean;
};

export type ContextTermRecord = {
	term: string;
	definition: string;
	avoid: string[];
	createdAt: string;
	updatedAt: string;
};

export type ContextDetails = {
	context: ContextRecord;
	terms: ContextTermRecord[];
};

export type ContextDirectoryTermSource = {
	contextKey: string;
	contextTitle: string;
	scopeKind: "default" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	definition: string;
	avoid: string[];
	updatedAt: string;
};

export type ContextDirectoryTerm = {
	term: string;
	sources: ContextDirectoryTermSource[];
	hasSharedSource: boolean;
	hasDuplicates: boolean;
	hasConflictingDefinitions: boolean;
};

export type ContextDirectory = {
	shared: ContextDetails;
	initiatives: ContextDetails[];
	terms: ContextDirectoryTerm[];
	duplicateTerms: string[];
};

export type ContextDirectoryView = "all" | "global" | "initiatives";

export type QueryContextDirectoryInput = {
	conflictsOnly?: boolean;
	query?: string;
	view?: ContextDirectoryView;
};

export type QueryContextDirectoryResult = {
	shared: ContextDetails | null;
	initiatives: ContextDetails[];
	terms: ContextDirectoryTerm[];
	duplicateTerms: string[];
	query: string;
	view: ContextDirectoryView;
	conflictsOnly: boolean;
};

export type ContextListItem = {
	context: ContextRecord;
	termCount: number;
};

export type ContextListResult = {
	contexts: ContextListItem[];
};

export type DefineContextTermResult = {
	context: ContextRecord;
	term: ContextTermRecord;
	created: boolean;
};

export type ForgetContextTermResult = {
	context: ContextRecord;
	term: string;
	removed: boolean;
};

/** Sync-only shape for a context row (ISS62/ADR16), independent of any particular scope resolution. */
export type ContextSyncRecord = {
	key: string;
	scopeEntityId: string | null;
	title: string;
	summary: string;
	createdAt: string;
	updatedAt: string;
};

/** Sync-only shape for a context term row (ISS62/ADR16), carrying its owning context's key explicitly. */
export type ContextTermSyncRecord = {
	contextKey: string;
	term: string;
	definition: string;
	avoid: string[];
	createdAt: string;
	updatedAt: string;
};
