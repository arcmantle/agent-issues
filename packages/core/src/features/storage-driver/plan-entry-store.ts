import type { LinkResult, UnlinkResult } from "../entity-store/store-types.js";
import type { PlanEntryHistoryEntry, PlanEntryRecord, PlanEntryRole, PlanEntryScopeDirection } from "../plan-entry/plan-entry-types.js";

export interface PlanEntryStore {
	createPlanEntry(input: {
		planId: string;
		role: PlanEntryRole;
		body: string;
		scopeDirection?: PlanEntryScopeDirection;
		referencedEntityIds?: string[];
		supersededEntryIds?: string[];
	}): Promise<PlanEntryRecord>;
	getPlanEntry(input: { entryId: string }): Promise<PlanEntryRecord>;
	updatePlanEntry(input: { entryId: string; body: string; expectedRevision: number; expectedContentHash: string }): Promise<PlanEntryRecord>;
	deletePlanEntry(input: { entryId: string; expectedRevision: number; expectedContentHash: string }): Promise<PlanEntryRecord>;
	linkPlanEntryIssue(input: { entryId: string; issueId: string }): Promise<LinkResult>;
	unlinkPlanEntryIssue(input: { entryId: string; issueId: string }): Promise<UnlinkResult>;
	listPlanEntries(input: { planId: string }): Promise<PlanEntryRecord[]>;
	listPlanEntryHistory(input: { entryId: string }): Promise<PlanEntryHistoryEntry[]>;
}