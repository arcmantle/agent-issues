import { Option } from "clipanion";

import { startLiveSite, stopLiveSite } from "../../site/index.js";

import { renderLiveSite, renderStopLiveSite } from "../renderers.js";
import { BaseCommand, parsePortOption, TenantCommand } from "../shared.js";

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

		await new Promise<void>((resolve, reject) => {
			if (result.server.listening) {
				resolve();
				return;
			}

			result.server.once("listening", resolve);
			result.server.once("error", reject);
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

export class StopSiteCommand extends BaseCommand {
	public static paths = [["stop-site"]];

	public portValue = Option.String("--port");

	public async execute(): Promise<number> {
		const result = await stopLiveSite({
			port: parsePortOption(this.portValue)
		});

		this.print(result, renderStopLiveSite(result));
		return 0;
	}
}
