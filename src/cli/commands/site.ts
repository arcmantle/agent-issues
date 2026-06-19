import { Option } from "clipanion";

import { startLiveSite } from "../../site/index.js";

import { renderLiveSite } from "../renderers.js";
import { parsePortOption, TenantCommand } from "../shared.js";

abstract class SiteCommand extends TenantCommand {
	public portValue = Option.String("--port");

	protected openInBrowser = false;

	public async execute(): Promise<number> {
		const result = startLiveSite({
			dbPath: this.dbPath,
			openInBrowser: this.openInBrowser,
			port: parsePortOption(this.portValue),
			tenant: this.tenant
		});

		this.print(result.info, renderLiveSite(result.info, this.openInBrowser));

		await new Promise<void>((resolve, reject) => {
			result.server.once("close", resolve);
			result.server.once("error", reject);
		});

		return 0;
	}
}

export class ServeSiteCommand extends SiteCommand {
	public static paths = [["serve-site"]];
}

export class OpenSiteCommand extends SiteCommand {
	public static paths = [["open-site"]];

	protected openInBrowser = true;
}
