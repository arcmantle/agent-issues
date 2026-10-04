import { createHash } from "node:crypto";
import type { RetrievedInstruction } from "@agent-issues/core";

const MAX_RESPONSE_BYTES = 8 * 1024;

export function formatInstructionResponse(instruction: RetrievedInstruction, offset = 0, expectedDocumentHash?: string) {
	const documentHash = createHash("sha256").update(JSON.stringify(instruction)).digest("hex");
	if (offset > 0 && expectedDocumentHash === undefined) {
		throw new Error("Instruction continuation requires documentHash. Stop and restart instruction_retrieve without offset and documentHash.");
	}
	if (expectedDocumentHash !== undefined && expectedDocumentHash !== documentHash) {
		throw new Error("Instruction changed or documentHash belongs to another key. Discard all parts and restart instruction_retrieve without offset and documentHash.");
	}
	const previousAtOffset = instruction.body.charCodeAt(offset - 1);
	const nextAtOffset = instruction.body.charCodeAt(offset);
	if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= instruction.body.length)
		|| (previousAtOffset >= 0xd800 && previousAtOffset <= 0xdbff && nextAtOffset >= 0xdc00 && nextAtOffset <= 0xdfff)) {
		throw new Error("Invalid instruction offset. Stop and restart instruction_retrieve without offset and documentHash.");
	}

	const responseAt = (position: number) => {
		let end = position;
		const previous = instruction.body.charCodeAt(end - 1);
		const next = instruction.body.charCodeAt(end);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
		const metadata = {
			version: instruction.version,
			documentHash,
			offset,
			nextOffset: end < instruction.body.length ? end : null
		};
		return { content: [
			{ type: "text" as const, text: JSON.stringify(metadata) },
			{ type: "text" as const, text: instruction.body.slice(offset, end) }
		] };
	};

	let lower = offset;
	let upper = Math.min(instruction.body.length, offset + MAX_RESPONSE_BYTES);
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (Buffer.byteLength(JSON.stringify(responseAt(middle)), "utf8") <= MAX_RESPONSE_BYTES) lower = middle;
		else upper = middle - 1;
	}
	return responseAt(lower);
}