import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const executeFile = promisify(execFile);

function errorCode(error: unknown) {
	return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export async function handlePrototypeApi(
	request: IncomingMessage,
	response: ServerResponse,
	next: (error?: unknown) => void
) {
	const url = new URL(request.url ?? '/', 'http://localhost');
	if (!['/api/folders', '/api/repository'].includes(url.pathname)) {
		next();
		return;
	}
	const port = request.socket.localPort;
	const origin = `http://127.0.0.1:${port}`;
	if (
		request.headers.host !== `127.0.0.1:${port}` ||
		(request.headers.origin && request.headers.origin !== origin) ||
		request.headers['sec-fetch-site'] === 'cross-site'
	) {
		response.writeHead(403).end();
		return;
	}
	if (request.method !== 'GET') {
		response.writeHead(405).end();
		return;
	}
	const send = (code: number, body: unknown) => {
		response.writeHead(code, {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		});
		response.end(JSON.stringify(body));
	};
	try {
		const suppliedPath = url.searchParams.get('path') || homedir();
		const expandedPath =
			suppliedPath === '~'
				? homedir()
				: suppliedPath.startsWith('~/')
					? join(homedir(), suppliedPath.slice(2))
					: suppliedPath;
		if (!isAbsolute(expandedPath)) {
			send(400, { error: 'Enter an absolute folder path.' });
			return;
		}
		const path = await realpath(expandedPath);
		if (!(await stat(path)).isDirectory()) {
			send(400, { error: 'Select a folder.' });
			return;
		}
		if (url.pathname === '/api/repository') {
			const metadataPath = join(path, '.git');
			let metadata;
			try {
				metadata = await stat(metadataPath);
			} catch (error) {
				if (errorCode(error) !== 'ENOENT') throw error;
				send(400, { error: 'Select a Git repository root folder.' });
				return;
			}
			await access(
				metadataPath,
				metadata.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK
			);
			let root: string;
			try {
				const result = await executeFile('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
					timeout: 3000,
				});
				root = await realpath(result.stdout.trim());
			} catch (error) {
				if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM')
					send(403, { error: 'Access to this repository is not permitted.' });
				else if (errorCode(error) === 'ENOENT') send(503, { error: 'Git is not available.' });
				else if (typeof error === 'object' && error !== null && 'killed' in error && error.killed)
					send(504, { error: 'Git verification timed out.' });
				else send(400, { error: 'Git could not verify this repository.' });
				return;
			}
			if (root !== path) {
				send(400, { error: 'Select the Git repository root folder.' });
				return;
			}
			send(200, { path, name: basename(path) });
		} else {
			const entries = await readdir(path, { withFileTypes: true });
			const directories = await Promise.all(
				entries.map(async (entry) => {
					const child = join(path, entry.name);
					if (entry.isDirectory()) return { name: entry.name, path: child };
					if (entry.isSymbolicLink()) {
						try {
							if ((await stat(child)).isDirectory()) return { name: entry.name, path: child };
						} catch {}
					}
					return null;
				})
			);
			send(200, {
				path,
				parent: dirname(path) === path ? null : dirname(path),
				root: parse(path).root,
				entries: directories
					.filter((entry) => entry !== null)
					.sort((first, second) => first.name.localeCompare(second.name)),
			});
		}
	} catch (error) {
		const denied = errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM';
		send(denied ? 403 : 400, {
			error: denied ? 'Access to this folder is not permitted.' : 'This folder is not available.',
		});
	}
}
