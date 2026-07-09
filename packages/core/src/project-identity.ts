import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveTenantRootPath, sanitizePathSegment } from "./database.js";

export type ProjectIdentitySource = "folder-name" | "git-repository" | "package-json" | "code-workspace" | "project-file";

export type ProjectIdentityResolution = {
	identity: string;
	source: ProjectIdentitySource;
};

/**
 * Dedicated, committed file carrying ONLY the explicit project identity
 * override (ADR10/ADR18). This resolver reads exclusively the "project"
 * field and ignores everything else, so the file must never carry a cloud
 * URL or credentials.
 */
export const PROJECT_IDENTITY_FILENAME = ".agent-issues-project.json";

/**
 * Resolves a project's identity deterministically (ADR10), by precedence:
 * dedicated project file > .code-workspace filename > package.json "name" >
 * git repository name > sanitized folder name. Anchored to the same
 * workspace root as tenant resolution so the same repo (or any of its
 * subdirectories) resolves to the same identity regardless of local
 * checkout path.
 */
export function resolveProjectIdentity(currentWorkingDirectory: string = process.cwd()): ProjectIdentityResolution {
	const root = resolveTenantRootPath(currentWorkingDirectory);

	return (
		resolveFromProjectFile(root) ??
		resolveFromCodeWorkspace(root) ??
		resolveFromPackageJson(root) ??
		resolveFromGitRepository(root) ??
		resolveFromFolderName(root)
	);
}

function resolveFromProjectFile(root: string): ProjectIdentityResolution | undefined {
	const projectFilePath = path.join(root, PROJECT_IDENTITY_FILENAME);
	if (!existsSync(projectFilePath)) return undefined;

	const project = parseJsonStringField(readFileSync(projectFilePath, "utf8"), "project");
	if (!project) return undefined;

	const identity = sanitizePathSegment(project);
	if (!identity) return undefined;

	return { identity, source: "project-file" };
}

function resolveFromCodeWorkspace(root: string): ProjectIdentityResolution | undefined {
	const codeWorkspaceFilenames = readdirSync(root)
		.filter((entry) => entry.endsWith(".code-workspace"))
		.sort();
	const [firstCodeWorkspaceFilename] = codeWorkspaceFilenames;
	if (!firstCodeWorkspaceFilename) return undefined;

	const identity = sanitizePathSegment(firstCodeWorkspaceFilename.replace(/\.code-workspace$/, ""));
	if (!identity) return undefined;

	return { identity, source: "code-workspace" };
}

function resolveFromPackageJson(root: string): ProjectIdentityResolution | undefined {
	const packageJsonPath = path.join(root, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;

	const name = parseJsonStringField(readFileSync(packageJsonPath, "utf8"), "name");
	if (!name) return undefined;

	const identity = sanitizePathSegment(name);
	if (!identity) return undefined;

	return { identity, source: "package-json" };
}

function parseJsonStringField(contents: string, field: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(contents);
		if (typeof parsed !== "object" || parsed === null) return undefined;

		const value = (parsed as Record<string, unknown>)[field];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function resolveFromGitRepository(root: string): ProjectIdentityResolution | undefined {
	const gitConfigPath = path.join(root, ".git", "config");
	if (!existsSync(gitConfigPath)) return undefined;

	const repositoryName = extractOriginRepositoryName(readFileSync(gitConfigPath, "utf8"));
	if (!repositoryName) return undefined;

	const identity = sanitizePathSegment(repositoryName);
	if (!identity) return undefined;

	return { identity, source: "git-repository" };
}

function extractOriginRepositoryName(gitConfigContents: string): string | undefined {
	const originSectionMatch = gitConfigContents.match(/\[remote "origin"]([\s\S]*?)(?:\n\[|$)/);
	if (!originSectionMatch) return undefined;

	const urlMatch = originSectionMatch[1].match(/^\s*url\s*=\s*(.+)$/m);
	if (!urlMatch) return undefined;

	const url = urlMatch[1].trim();
	const lastSegment = url.split(/[/:]/).pop() ?? "";
	return lastSegment.replace(/\.git$/, "");
}

function resolveFromFolderName(root: string): ProjectIdentityResolution {
	const identity = sanitizePathSegment(path.basename(root)) || "workspace";
	return { identity, source: "folder-name" };
}
