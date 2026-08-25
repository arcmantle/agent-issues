type McpDataCommand = {
	command: string;
	toolNames: readonly string[];
};

const INCLUDED_MCP_DATA_COMMANDS: readonly McpDataCommand[] = [
	{ command: "create", toolNames: ["entity_create"] },
	{ command: "edit", toolNames: ["entity_edit"] },
	{ command: "archive", toolNames: ["entity_archive"] },
	{ command: "delete", toolNames: ["entity_delete_inspect", "entity_delete"] },
	{ command: "move", toolNames: ["entity_move"] },
	{ command: "status", toolNames: ["entity_status"] },
	{ command: "list", toolNames: ["entity_list"] },
	{ command: "history", toolNames: ["entity_history"] },
	{ command: "show", toolNames: ["entity_show", "initiative_bundle"] },
	{ command: "context list", toolNames: ["context_list"] },
	{ command: "context show", toolNames: ["context_show"] },
	{ command: "context directory", toolNames: ["context_directory"] },
	{ command: "context search", toolNames: ["context_search"] },
	{ command: "context conflicts", toolNames: ["context_conflicts"] },
	{ command: "context set", toolNames: ["context_set"] },
	{ command: "context define", toolNames: ["context_term_define"] },
	{ command: "context forget", toolNames: ["context_term_forget"] },
	{ command: "history --context", toolNames: ["context_revision", "context_term_revision"] },
	{ command: "comment add", toolNames: ["comment_create"] },
	{ command: "comment edit", toolNames: ["comment_edit"] },
	{ command: "comment delete", toolNames: ["comment_delete"] },
	{ command: "comment list", toolNames: ["comment_list"] },
	{ command: "comment history", toolNames: ["comment_history"] },
	{ command: "plan-entry add", toolNames: ["plan_entry_create"] },
	{ command: "plan-entry edit", toolNames: ["plan_entry_edit"] },
	{ command: "plan-entry delete", toolNames: ["plan_entry_delete"] },
	{ command: "plan-entry list", toolNames: ["plan_entry_list"] },
	{ command: "plan-entry history", toolNames: ["plan_entry_history"] },
	{ command: "link", toolNames: ["relation_link", "plan_entry_issue_link"] },
	{ command: "unlink", toolNames: ["relation_unlink", "plan_entry_issue_unlink"] },
	{ command: "relations", toolNames: ["relation_query"] },
	{ command: "next-work", toolNames: ["entity_next_work"] },
	{ command: "orphans", toolNames: ["entity_orphans"] },
	{ command: "tenant list", toolNames: ["tenant_list"] },
	{ command: "tenant rename", toolNames: ["tenant_rename"] },
	{ command: "tenant delete", toolNames: ["tenant_delete_inspect", "tenant_delete"] },
	{ command: "restore", toolNames: ["entity_restore_inspect", "entity_restore"] },
	{ command: "backfill-bodies", toolNames: ["body_backfill_inspect", "body_backfill"] }
];

export function auditMcpToolRegistrations(registeredToolNames: Iterable<string>): { missing: Array<{ command: string; toolName: string }> } {
	const registeredTools = new Set(registeredToolNames);
	const missing = INCLUDED_MCP_DATA_COMMANDS.flatMap(({ command, toolNames }) =>
		toolNames.filter((toolName) => !registeredTools.has(toolName)).map((toolName) => ({ command, toolName }))
	);

	return { missing };
}