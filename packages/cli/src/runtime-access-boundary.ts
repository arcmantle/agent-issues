import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

export interface RuntimeAccessBoundaryViolation {
	file: string;
	line: number;
	driver: "pg" | "better-sqlite3";
	method: "query" | "prepare" | "exec";
}

const allowedRuntimeInfrastructure = new Set([
	"api-local/src/db/database.ts",
	"api-local/src/db/migration-runner.ts",
	"api-local/src/db/sqlite-executor.ts",
	"api-pg/src/db/connection.ts",
	"api-pg/src/db/migration-runner.ts",
	"api-pg/src/db/tenant-admin.ts",
	"api-pg/src/db/test-tenant-cleanup.ts"
]);

function isAllowedRuntimeInfrastructure(file: string): boolean {
	return allowedRuntimeInfrastructure.has(file) || file.startsWith("api-local/src/migrations/") || file.startsWith("api-pg/src/migrations/");
}

function visitAst(value: unknown, visit: (node: Record<string, unknown>) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			visitAst(item, visit);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		return;
	}

	const node = value as Record<string, unknown>;
	if (typeof node.type === "string") {
		visit(node);
	}
	for (const [key, child] of Object.entries(node)) {
		if (key !== "loc" && key !== "start" && key !== "end") {
			visitAst(child, visit);
		}
	}
}

function listTypeScriptFiles(root: string): string[] {
	const files: string[] = [];

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...listTypeScriptFiles(entryPath));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(entryPath);
		}
	}

	return files;
}

export function findRuntimeAccessBoundaryViolations(root: string): RuntimeAccessBoundaryViolation[] {
	const violations: RuntimeAccessBoundaryViolation[] = [];

	for (const filePath of listTypeScriptFiles(root)) {
		const relativeFile = path.relative(root, filePath).split(path.sep).join("/").replace(/^packages\//, "");
		if ((!relativeFile.startsWith("api-pg/src/") && !relativeFile.startsWith("api-local/src/")) || isAllowedRuntimeInfrastructure(relativeFile)) {
			continue;
		}

		const ast = parse(readFileSync(filePath, "utf8"), { sourceType: "module", plugins: ["typescript"] });
		const driver = relativeFile.startsWith("api-pg/") ? "pg" : "better-sqlite3";

		visitAst(ast, (node) => {
			const callee = node.callee as Record<string, unknown> | undefined;
			const property = callee?.property as Record<string, unknown> | undefined;
			const method = node.type === "CallExpression" && callee?.type === "MemberExpression" && !callee.computed && property?.type === "Identifier"
				? property.name
				: undefined;
			if (
				(driver === "pg" && method === "query") ||
				(driver === "better-sqlite3" && (method === "prepare" || method === "exec"))
			) {
				const loc = node.loc as { start?: { line?: number } } | undefined;
				violations.push({
					file: relativeFile,
					line: loc?.start?.line ?? 1,
					driver,
					method: method as RuntimeAccessBoundaryViolation["method"]
				});
			}
		});
	}

	return violations;
}