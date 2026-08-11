import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_IDENTITY_FILENAME, resolveProjectIdentity } from "./project-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

function createWorkspace(folderName: string): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-identity-"));
	tempDirs.push(tempDir);

	const workspaceRoot = path.join(tempDir, folderName);
	mkdirSync(workspaceRoot, { recursive: true });
	return workspaceRoot;
}

function writeGitRemote(workspaceRoot: string, url: string): void {
	mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
	writeFileSync(
		path.join(workspaceRoot, ".git", "config"),
		`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
	);
}

describe("project identity resolution", () => {
	it("falls back to the sanitized folder name for a non-git, override-free workspace", () => {
		const workspaceRoot = createWorkspace("My Cool App");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "my-cool-app",
			source: "folder-name"
		});
	});

	it("derives the identity from the git remote origin repository name, overriding the folder name", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeGitRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("parses an SSH-style git remote origin url the same way as an HTTPS one", () => {
		const workspaceRoot = createWorkspace("another-checkout-name");
		writeGitRemote(workspaceRoot, "git@github.com:arcmantle/agent-issues.git");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("prefers the git repository name over a package.json workspace label", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeGitRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");
		writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "agent-issues-workspace" }));

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("prefers the .code-workspace filename over the package.json name field", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "My Package Name" }));
		writeFileSync(path.join(workspaceRoot, "Team Workspace.code-workspace"), JSON.stringify({ folders: [] }));

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "team-workspace",
			source: "code-workspace"
		});
	});

	it("prefers the dedicated agent-issues project file over the .code-workspace filename", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(path.join(workspaceRoot, "Team Workspace.code-workspace"), JSON.stringify({ folders: [] }));
		writeFileSync(path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME), JSON.stringify({ project: "Explicit Name" }));

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "explicit-name",
			source: "project-file"
		});
	});

	it("never surfaces extra fields from the dedicated project file, only identity and source", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(
			path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME),
			JSON.stringify({ project: "Explicit Name", cloudUrl: "https://example.test", token: "super-secret" })
		);

		expect(Object.keys(resolveProjectIdentity(workspaceRoot)).sort()).toEqual(["identity", "source"]);
	});

	it("resolves the same identity for the same git repository checked out at two different absolute paths", () => {
		const firstCheckout = createWorkspace("checkout-one");
		const secondCheckout = createWorkspace("checkout-two");
		writeGitRemote(firstCheckout, "https://github.com/arcmantle/agent-issues.git");
		writeGitRemote(secondCheckout, "https://github.com/arcmantle/agent-issues.git");

		expect(firstCheckout).not.toBe(secondCheckout);
		expect(resolveProjectIdentity(firstCheckout)).toEqual(resolveProjectIdentity(secondCheckout));
	});

	it("falls through to the next source when the dedicated project file is malformed JSON", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeGitRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");
		writeFileSync(path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME), "{ not valid json");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});
});
