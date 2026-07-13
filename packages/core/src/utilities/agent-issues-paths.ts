import { homedir } from "node:os";
import path from "node:path";

/**
 * Directory name for agent-issues' local state under the user's home
 * directory (`~/.agent-issues`). Shared by the sqlite database's own default
 * location (`@agent-issues/api-local`) and the daemon discovery/lock files
 * below, so both agree on the same root without either depending on the
 * other.
 */
export const AGENT_ISSUES_DIRECTORY = ".agent-issues";

/** Filename for the default local sqlite database, resolved under `resolveAgentIssuesHomeDirectory()`. */
export const DEFAULT_DATABASE_FILENAME = "agent-issues.db";

/** Resolves `~/.agent-issues`, the root directory for all local agent-issues state (daemon discovery, the default sqlite database, credentials, etc). */
export function resolveAgentIssuesHomeDirectory(): string {
	return path.join(homedir(), AGENT_ISSUES_DIRECTORY);
}

/**
 * Resolves the default local sqlite database path (`~/.agent-issues/agent-issues.db`).
 * Used by `daemon-state.ts` purely as the comparison target for the daemon's
 * default discovery slot (ISS192) - it never opens this file itself, so it
 * can live here without `@agent-issues/core` depending on
 * `@agent-issues/api-local`.
 */
export function resolveDefaultDatabasePath(): string {
	return path.join(resolveAgentIssuesHomeDirectory(), DEFAULT_DATABASE_FILENAME);
}
