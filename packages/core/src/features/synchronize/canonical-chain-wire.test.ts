import { describe, expect, it } from "vitest";

import {
	decodeCanonicalChainBundle,
	encodeCanonicalChainBundle,
	type CanonicalChainBundle
} from "./canonical-chain.js";
import { encodeCanonicalReference } from "../entity-store/canonical-reference.js";

describe("canonical chain wire encoding", () => {
	it("round-trips reverse patches through explicit base64 strings", () => {
		const stableId = "00000000-0000-4000-8000-000000000001";
		const bundle = {
			entities: [{ head: { id: stableId, reference: encodeCanonicalReference("issue", stableId), kind: "issue", parentId: null }, deltas: [{ reversePatch: Uint8Array.from([0, 127, 128, 255]), sourceHash: "01".repeat(32), targetHash: "fe".repeat(32) }] }],
			contexts: [],
			contextTerms: [],
			users: []
		} as unknown as CanonicalChainBundle;

		const encoded = encodeCanonicalChainBundle(bundle);

		expect(encoded.entities[0]?.deltas[0]?.reversePatch).toBe("AH+A/w==");
		expect(encoded.entities[0]?.deltas[0]?.sourceHash).toBe("01".repeat(32));
		expect(encoded.entities[0]?.deltas[0]?.targetHash).toBe("fe".repeat(32));
		expect(JSON.stringify(encoded)).not.toContain('"0":');
		const decoded = decodeCanonicalChainBundle(encoded).entities[0]?.deltas[0];
		expect(decoded?.reversePatch).toEqual(Uint8Array.from([0, 127, 128, 255]));
		expect(decoded?.sourceHash).toBe("01".repeat(32));
		expect(decoded?.targetHash).toBe("fe".repeat(32));
	});

	it("rejects a canonical reference that does not encode id", () => {
		const stableId = "00000000-0000-4000-8000-000000000001";
		const bundle = {
			entities: [{ head: { id: "00000000-0000-4000-8000-000000000002", reference: encodeCanonicalReference("issue", stableId), kind: "issue", parentId: null }, deltas: [] }],
			contexts: [],
			contextTerms: [],
			users: []
		} as unknown as Parameters<typeof decodeCanonicalChainBundle>[0];

		expect(() => decodeCanonicalChainBundle(bundle)).toThrow(/does not match issue Stable identity/);
	});
});