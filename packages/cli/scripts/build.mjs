import { chmodSync, cpSync, rmSync } from "node:fs";

import { build } from "esbuild";
import { writeBuildInfoFile } from "@agent-issues/api-local";

import { buildPlugin } from "./build-plugin.mjs";

rmSync("dist", { force: true, recursive: true });
rmSync("site/dist", { force: true, recursive: true });
rmSync("kanban/dist", { force: true, recursive: true });
cpSync("../site/dist", "site/dist", { recursive: true });
cpSync("../kanban/dist", "kanban/dist", { recursive: true });

await build({
	bundle: true,
	entryPoints: ["src/plan-preview/main.ts"],
	format: "esm",
	minify: true,
	outfile: "dist/plan-preview.js",
	platform: "browser",
	target: "es2024"
});

await build({
	bundle: true,
	entryPoints: ["src/issue-preview/main.ts"],
	format: "esm",
	minify: true,
	outfile: "dist/issue-preview.js",
	platform: "browser",
	target: "es2024"
});

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

buildPlugin({ sourceDir: ".", targetDir: "dist/plugin" });
writeBuildInfoFile("dist");
chmodSync("dist/cli.js", 0o755);