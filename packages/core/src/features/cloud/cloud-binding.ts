import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveAgentIssuesHomeDirectory } from "../entity-store/database.js";

export type CloudBinding = {
	projectIdentity: string;
	cloudApiUrl: string;
	tenantId: string;
};

export type CloudBindingStoreOptions = {
	/**
	 * Overrides the directory the bindings file lives under. Production
	 * defaults to `resolveAgentIssuesHomeDirectory()` (`~/.agent-issues`);
	 * tests inject a temp directory so no real user state is touched.
	 */
	homeDirectory?: string;
};

const CLOUD_BINDINGS_FILENAME = "cloud-bindings.json";

type CloudBindingFileShape = {
	bindings: Record<string, CloudBinding>;
};

function resolveCloudBindingsFilePath(options?: CloudBindingStoreOptions): string {
	const homeDirectory = options?.homeDirectory ?? resolveAgentIssuesHomeDirectory();
	return path.join(homeDirectory, CLOUD_BINDINGS_FILENAME);
}

function readCloudBindingFile(options?: CloudBindingStoreOptions): CloudBindingFileShape {
	const filePath = resolveCloudBindingsFilePath(options);
	if (!existsSync(filePath)) return { bindings: {} };

	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return { bindings: {} };

		const { bindings } = parsed as Partial<CloudBindingFileShape>;
		return { bindings: bindings && typeof bindings === "object" ? bindings : {} };
	} catch {
		return { bindings: {} };
	}
}

function writeCloudBindingFile(file: CloudBindingFileShape, options?: CloudBindingStoreOptions): void {
	const filePath = resolveCloudBindingsFilePath(options);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/**
 * Records that `binding.projectIdentity` points at a cloud API + tenant
 * (ADR18): per-project, user-local, git-remote style. Re-binding an already
 * bound project overwrites its previous binding. Never touches any
 * committed project file - this is the whole point of the seam (ADR10).
 */
export function bindCloudProject(binding: CloudBinding, options?: CloudBindingStoreOptions): void {
	const file = readCloudBindingFile(options);
	file.bindings[binding.projectIdentity] = binding;
	writeCloudBindingFile(file, options);
}

/** Returns a project's cloud binding, or undefined if it has none (meaning local, ADR18). */
export function getCloudBinding(projectIdentity: string, options?: CloudBindingStoreOptions): CloudBinding | undefined {
	return readCloudBindingFile(options).bindings[projectIdentity];
}

/** Removes a project's cloud binding. A harmless no-op if it had none. */
export function unbindCloudProject(projectIdentity: string, options?: CloudBindingStoreOptions): void {
	const file = readCloudBindingFile(options);
	delete file.bindings[projectIdentity];
	writeCloudBindingFile(file, options);
}

/** Returns every bound project, regardless of which project is current. */
export function listCloudBindings(options?: CloudBindingStoreOptions): CloudBinding[] {
	return Object.values(readCloudBindingFile(options).bindings);
}
