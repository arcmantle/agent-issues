import { chmodSync, cpSync, rmSync } from "node:fs";

import { build } from "esbuild";
import { writeBuildInfoFile } from "@agent-issues/api-local";

rmSync("dist", { force: true, recursive: true });
rmSync("site/dist", { force: true, recursive: true });
rmSync("kanban/dist", { force: true, recursive: true });
cpSync("../site/dist", "site/dist", { recursive: true });
cpSync("../kanban/dist", "kanban/dist", { recursive: true });

await build({
	banner: {
		js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
	},
	bundle: true,
	define: {
		__AGENT_ISSUES_BUILD_MODE__: JSON.stringify("production"),
		__AGENT_ISSUES_BUNDLED__: "true"
	},
	entryPoints: ["src/cli.ts"],
	external: ["better-sqlite3"],
	format: "esm",
	outfile: "dist/cli.js",
	platform: "node",
	target: "node24"
});

writeBuildInfoFile("dist");
chmodSync("dist/cli.js", 0o755);