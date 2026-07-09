#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ISSUE_ID_PATTERN = /\bISS\d+\b/i;
const STATE_DIR = path.join(os.tmpdir(), 'agent-issues-agent-hooks');

function readStdin() {
	return new Promise((resolve, reject) => {
		let buffer = '';

		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => {
			buffer += chunk;
		});
		process.stdin.on('end', () => {
			resolve(buffer);
		});
		process.stdin.on('error', reject);
	});
}

function safeJsonParse(text) {
	if (!text.trim()) {
		return {};
	}

	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

function statePathFor(sessionId) {
	return path.join(STATE_DIR, `${sessionId}.json`);
}

function readState(sessionId) {
	if (!sessionId) {
		return null;
	}

	const filePath = statePathFor(sessionId);
	if (!fs.existsSync(filePath)) {
		return null;
	}

	return safeJsonParse(fs.readFileSync(filePath, 'utf8'));
}

function writeState(sessionId, state) {
	if (!sessionId) {
		return;
	}

	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(statePathFor(sessionId), JSON.stringify(state));
}

function deleteState(sessionId) {
	if (!sessionId) {
		return;
	}

	const filePath = statePathFor(sessionId);
	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}

function extractIssueId(prompt) {
	const match = typeof prompt === 'string' ? prompt.match(ISSUE_ID_PATTERN) : null;
	return match ? match[0].toUpperCase() : null;
}

function isExecuteTool(toolName) {
	return /run|terminal|command|shell|bash|execute/i.test(toolName ?? '');
}

function isEditTool(toolName) {
	return /edit|write|apply[_-]?patch|create[_-]?file|replace/i.test(toolName ?? '');
}

function collectStrings(value, output = []) {
	if (typeof value === 'string') {
		output.push(value);
		return output;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			collectStrings(entry, output);
		}
		return output;
	}

	if (value && typeof value === 'object') {
		for (const entry of Object.values(value)) {
			collectStrings(entry, output);
		}
	}

	return output;
}

function evaluateProgress(commandText, issueId, currentProgress) {
	const escapedIssueId = issueId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const progress = {
		show: Boolean(currentProgress?.show),
		relations: Boolean(currentProgress?.relations),
		context: Boolean(currentProgress?.context)
	};

	if (new RegExp(`\\bagent-issues\\s+show\\s+${escapedIssueId}\\b`, 'i').test(commandText)) {
		progress.show = true;
	}

	if (new RegExp(`\\bagent-issues\\s+relations\\s+${escapedIssueId}\\b`, 'i').test(commandText)) {
		progress.relations = true;
	}

	if (new RegExp(`\\bagent-issues\\s+context\\s+show\\s+${escapedIssueId}\\b`, 'i').test(commandText)) {
		progress.context = true;
	}

	return progress;
}

function missingSteps(progress) {
	const missing = [];

	if (!progress.show) {
		missing.push('agent-issues show');
	}

	if (!progress.relations) {
		missing.push('agent-issues relations');
	}

	if (!progress.context) {
		missing.push('agent-issues context show');
	}

	return missing;
}

function allow(additionalContext) {
	const result = {
		continue: true
	};

	if (additionalContext) {
		result.hookSpecificOutput = {
			hookEventName: 'PreToolUse',
			permissionDecision: 'allow',
			additionalContext
		};
	}

	return result;
}

function deny(reason, additionalContext) {
	const result = {
		continue: true,
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	};

	if (additionalContext) {
		result.hookSpecificOutput.additionalContext = additionalContext;
	}

	return result;
}

async function main() {
	const payload = safeJsonParse(await readStdin());
	const eventName = payload.hookEventName;
	const sessionId = payload.sessionId;

	if (eventName === 'UserPromptSubmit') {
		const issueId = extractIssueId(payload.prompt);

		if (!issueId) {
			deleteState(sessionId);
			process.stdout.write(JSON.stringify({ continue: true }));
			return;
		}

		writeState(sessionId, {
			issueId,
			progress: {
				show: false,
				relations: false,
				context: false
			},
			contextLoaded: false
		});

		process.stdout.write(JSON.stringify({ continue: true }));
		return;
	}

	if (eventName !== 'PreToolUse') {
		process.stdout.write(JSON.stringify({ continue: true }));
		return;
	}

	const state = readState(sessionId);
	if (!state?.issueId || state.contextLoaded) {
		process.stdout.write(JSON.stringify({ continue: true }));
		return;
	}

	const toolName = payload.tool_name ?? '';
	if (!isExecuteTool(toolName) && !isEditTool(toolName)) {
		process.stdout.write(JSON.stringify({ continue: true }));
		return;
	}

	if (isEditTool(toolName)) {
		process.stdout.write(
			JSON.stringify(
				deny(
					`Load agent-issues context for ${state.issueId} before editing files.`,
					`Run agent-issues show ${state.issueId} --json, agent-issues relations ${state.issueId} --json, and agent-issues context show ${state.issueId} --json first.`
				)
			)
		);
		return;
	}

	const commandText = collectStrings(payload.tool_input).join('\n');
	const progress = evaluateProgress(commandText, state.issueId, state.progress);
	const contextLoaded = progress.show && progress.relations && progress.context;

	writeState(sessionId, {
		issueId: state.issueId,
		progress,
		contextLoaded
	});

	if (contextLoaded) {
		process.stdout.write(
			JSON.stringify(
				allow(`Issue context loaded for ${state.issueId}. Keep subsequent work scoped to that issue.`)
			)
		);
		return;
	}

	if (progress.show || progress.relations || progress.context) {
		process.stdout.write(
			JSON.stringify(
				allow(
					`Continue loading issue context for ${state.issueId}. Remaining commands: ${missingSteps(progress).join(', ')}.`
				)
			)
		);
		return;
	}

	process.stdout.write(
		JSON.stringify(
			deny(
				`Run the agent-issues preload for ${state.issueId} before using terminal commands unrelated to issue context.`,
				`Allowed preload commands: agent-issues show ${state.issueId} --json, agent-issues relations ${state.issueId} --json, and agent-issues context show ${state.issueId} --json.`
			)
		)
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
});