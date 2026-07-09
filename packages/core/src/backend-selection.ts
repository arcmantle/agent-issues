import { getCloudBinding, type CloudBinding, type CloudBindingStoreOptions } from "./cloud-binding.js";

export type Backend = "local" | "cloud";

export type BackendSelection = { backend: "local" } | { backend: "cloud"; binding: CloudBinding };

export type ResolveBackendSelectionOptions = CloudBindingStoreOptions & {
	/** An explicit `--cloud`/`--local` CLI flag, if the caller passed one. */
	explicitBackend?: Backend;
	/** The project identity (`resolveProjectIdentity`, ADR10) the binding is keyed by. */
	projectIdentity: string;
	/** Injectable for tests; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
};

const BACKEND_ENV_VAR = "AGENT_ISSUES_BACKEND";

function requireCloudBinding(projectIdentity: string, options?: CloudBindingStoreOptions): CloudBinding {
	const binding = getCloudBinding(projectIdentity, options);
	if (!binding) {
		throw new Error(`No cloud binding for this project. Run "agent-issues cloud bind" first (ADR18).`);
	}

	return binding;
}

/**
 * Resolves which backend a project should use, following ADR18's exact
 * precedence: explicit `--cloud`/`--local` flag > env var > per-project
 * user-local cloud binding > default local. Absent any config, the CLI is
 * always local (US28) - honoring cloud as opt-in and never mandatory.
 */
export function resolveBackendSelection(options: ResolveBackendSelectionOptions): BackendSelection {
	const { explicitBackend, projectIdentity } = options;
	const env = options.env ?? process.env;

	if (explicitBackend === "local") {
		return { backend: "local" };
	}

	if (explicitBackend === "cloud") {
		return { backend: "cloud", binding: requireCloudBinding(projectIdentity, options) };
	}

	const envBackend = env[BACKEND_ENV_VAR];
	if (envBackend === "local") {
		return { backend: "local" };
	}

	if (envBackend === "cloud") {
		return { backend: "cloud", binding: requireCloudBinding(projectIdentity, options) };
	}

	const binding = getCloudBinding(projectIdentity, options);
	if (binding) {
		return { backend: "cloud", binding };
	}

	return { backend: "local" };
}
