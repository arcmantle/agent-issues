import { Option } from "clipanion";

import { bindCloudProject, getCloudBinding, unbindCloudProject } from "../../cloud-binding.js";
import { resolveBackendSelection } from "../../backend-selection.js";
import { resolveProjectIdentity } from "../../project-identity.js";

import { renderCloudBind, renderCloudStatus, renderCloudUnbind } from "../renderers.js";
import { BaseCommand, requireOption } from "../shared.js";

/**
 * The cloud-binding command family (ADR18): git-remote style, per-project,
 * user-local. `withStore`'s seam boundary (slice 3, ISS55) is what actually
 * makes command *behavior* switch backend - these commands only manage the
 * binding a project resolves through.
 */
export class CloudBindCommand extends BaseCommand {
	public static paths = [["cloud", "bind"]];

	public url = Option.String("--url");
	public tenantId = Option.String("--tenant-id");

	public async execute(): Promise<number> {
		const cloudApiUrl = requireOption(this.url, '`cloud bind` requires --url <cloudApiUrl>.');
		const tenantId = requireOption(this.tenantId, '`cloud bind` requires --tenant-id <tenantId>.');
		const { identity: projectIdentity } = resolveProjectIdentity(this.context.cwd);

		const binding = { projectIdentity, cloudApiUrl, tenantId };
		bindCloudProject(binding);

		this.print({ command: "cloud-bind" as const, binding }, renderCloudBind(binding));
		return 0;
	}
}

export class CloudUnbindCommand extends BaseCommand {
	public static paths = [["cloud", "unbind"]];

	public async execute(): Promise<number> {
		const { identity: projectIdentity } = resolveProjectIdentity(this.context.cwd);
		const wasBound = getCloudBinding(projectIdentity) !== undefined;

		unbindCloudProject(projectIdentity);

		this.print({ command: "cloud-unbind" as const, projectIdentity, wasBound }, renderCloudUnbind(projectIdentity, wasBound));
		return 0;
	}
}

export class CloudStatusCommand extends BaseCommand {
	public static paths = [["cloud", "status"]];

	public async execute(): Promise<number> {
		const { identity: projectIdentity } = resolveProjectIdentity(this.context.cwd);
		const selection = resolveBackendSelection({ projectIdentity });

		const result =
			selection.backend === "cloud"
				? {
						command: "cloud-status" as const,
						projectIdentity,
						backend: "cloud" as const,
						binding: { cloudApiUrl: selection.binding.cloudApiUrl, tenantId: selection.binding.tenantId }
					}
				: { command: "cloud-status" as const, projectIdentity, backend: "local" as const };

		this.print(result, renderCloudStatus(result));
		return 0;
	}
}
