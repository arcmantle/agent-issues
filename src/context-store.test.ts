import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defineContextTerm, getContextDetails, getContextDirectory, queryContextDirectory } from "./context-store.js";
import { ensureDatabase, type DatabaseHandle } from "./database.js";
import { createEntity } from "./store.js";

let tempDir: string | null = null;

function openTestDatabase(): DatabaseHandle {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-"));
	const { db } = ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	return db;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("context directory", () => {
	it("includes the shared glossary and initiative-scoped discovery with duplicate detection", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Canonical order.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Payment-specific order.",
			scopeRef: initiative.id
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: initiative.id,
			avoid: ["queued run"]
		});

		const directory = getContextDirectory(db);

		expect(directory.shared.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(directory.initiatives).toHaveLength(1);
		expect(directory.duplicateTerms).toEqual(["Order"]);

		const order = directory.terms.find((entry) => entry.term === "Order");
		expect(order?.hasDuplicates).toBe(true);
		expect(order?.hasSharedSource).toBe(true);
		expect(order?.hasConflictingDefinitions).toBe(true);
		expect(order?.sources.map((source) => source.scopeLabel)).toEqual(["Shared", "Payments"]);

		const settlement = directory.terms.find((entry) => entry.term === "Settlement");
		expect(settlement?.hasDuplicates).toBe(false);
		expect(settlement?.sources[0]?.avoid).toEqual(["queued run"]);
	});

	it("keeps scoped context reads precise for initiative lookups", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Semantic Review" });

		defineContextTerm(db, {
			term: "Review Snapshot",
			definition: "Stored review output for one target.",
			scopeRef: initiative.id
		});

		const details = getContextDetails(db, { scopeRef: initiative.id });

		expect(details.context.scopeKind).toBe("initiative");
		expect(details.context.scopeEntityId).toBe(initiative.id);
		expect(details.terms.map((term) => term.term)).toEqual(["Review Snapshot"]);
	});

	it("supports global-only search against shared context", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Administration",
			definition: "Shared admin surface.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: initiative.id
		});

		const result = queryContextDirectory(db, { query: "admin", view: "global" });

		expect(result.shared?.terms.map((term) => term.term)).toEqual(["Administration"]);
		expect(result.initiatives).toEqual([]);
		expect(result.terms.map((term) => term.term)).toEqual(["Administration"]);
	});

	it("supports initiative-only search without returning shared matches", () => {
		const db = openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });
		const shipping = createEntity(db, { kind: "initiative", title: "Shipping" });

		defineContextTerm(db, {
			term: "Administration",
			definition: "Shared admin surface.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: payments.id
		});
		defineContextTerm(db, {
			term: "Shipment batch",
			definition: "Grouped dispatch.",
			scopeRef: shipping.id
		});

		const result = queryContextDirectory(db, { query: "settle", view: "initiatives" });

		expect(result.shared).toBeNull();
		expect(result.initiatives.map((details) => details.context.scopeLabel)).toEqual(["Payments"]);
		expect(result.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("supports conflicts-only queries", () => {
		const db = openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });
		const shipping = createEntity(db, { kind: "initiative", title: "Shipping" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Canonical order.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Payment order.",
			scopeRef: payments.id
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Shipping order.",
			scopeRef: shipping.id
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: payments.id
		});

		const result = queryContextDirectory(db, { conflictsOnly: true });

		expect(result.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(result.duplicateTerms).toEqual(["Order"]);
		expect(result.terms[0]?.sources).toHaveLength(3);
	});

	it("avoids substring-only false positives during search", () => {
		const db = openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Asset Inspector",
			definition: "Shows preview affordances for the selected asset.",
			scopeRef: initiative.id
		});
		defineContextTerm(db, {
			term: "Review Snapshot",
			definition: "Captured review result.",
			scopeRef: initiative.id
		});

		const result = queryContextDirectory(db, { query: "review", view: "initiatives" });

		expect(result.terms.map((term) => term.term)).toEqual(["Review Snapshot"]);
	});
});