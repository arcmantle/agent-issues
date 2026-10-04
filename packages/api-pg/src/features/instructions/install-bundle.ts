import { createHash } from "node:crypto";
import { normalizeInstructionBundle, type InstructionBundle } from "@agent-issues/core";
import type { Pool } from "pg";

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function installInstructionBundle(pool: Pool, bundle: InstructionBundle): Promise<void> {
	const { items } = normalizeInstructionBundle(bundle);
	const contentHash = hash(JSON.stringify(items));
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("LOCK TABLE instruction_bundles IN EXCLUSIVE MODE");
		const existing = await client.query("SELECT content_hash FROM instruction_bundles WHERE version = $1", [bundle.version]);
		if (existing.rows.length) {
			if (existing.rows[0].content_hash !== contentHash) throw new Error(`Instruction bundle is immutable: ${bundle.version}`);
		} else {
			await client.query("INSERT INTO instruction_bundles (version, content_hash) VALUES ($1, $2)", [bundle.version, contentHash]);
			for (const item of items) {
				await client.query("INSERT INTO instruction_defaults (version, item_key, kind, body, revision, content_hash) VALUES ($1, $2, $3, $4, 1, $5)",
					[bundle.version, item.key, item.kind, item.body, hash(item.body)]);
			}
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}