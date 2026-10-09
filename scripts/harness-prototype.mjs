import { createServer } from 'node:http';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

if (process.env.NODE_ENV === 'production') {
	throw new Error('The harness prototype is disabled in production.');
}

const files = new Map([
	['/', ['harness-workspace-prototype.html', 'text/html']],
	['/harness-workspace-prototype.html', ['harness-workspace-prototype.html', 'text/html']],
	['/harness-workspace-prototype.css', ['harness-workspace-prototype.css', 'text/css']],
	['/harness-workspace-prototype.js', ['harness-workspace-prototype.js', 'text/javascript']],
]);
const server = createServer(async (request, response) => {
	const url = new URL(request.url, 'http://localhost');
	if (['/api/folders', '/api/repository'].includes(url.pathname)) {
		const origin = `http://127.0.0.1:${port}`;
		if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
			response.writeHead(403).end();
			return;
		}
		if (request.method !== 'GET') { response.writeHead(405).end(); return; }
		const send = (code, body) => {
			response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end(JSON.stringify(body));
		};
		try {
			const suppliedPath = url.searchParams.get('path') || homedir();
			const expandedPath = suppliedPath === '~' ? homedir() : suppliedPath.startsWith('~/') ? join(homedir(), suppliedPath.slice(2)) : suppliedPath;
			if (!isAbsolute(expandedPath)) { send(400, { error: 'Enter an absolute folder path.' }); return; }
			const path = await realpath(expandedPath);
			if (!(await stat(path)).isDirectory()) { send(400, { error: 'Select a folder.' }); return; }
			if (url.pathname === '/api/repository') {
				let root;
				const metadataPath = join(path, '.git');
				let metadata;
				try { metadata = await stat(metadataPath); }
				catch (error) {
					if (error.code !== 'ENOENT') throw error;
					send(400, { error: 'Select a Git repository root folder.' });
					return;
				}
				await access(metadataPath, metadata.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);
				try {
					const result = await executeFile('git', ['-C', path, 'rev-parse', '--show-toplevel'], { timeout: 3000 });
					root = await realpath(result.stdout.trim());
				} catch (error) {
					if (error.code === 'EACCES' || error.code === 'EPERM') { send(403, { error: 'Access to this repository is not permitted.' }); }
					else if (error.code === 'ENOENT') { send(503, { error: 'Git is not available.' }); }
					else if (error.killed) { send(504, { error: 'Git verification timed out.' }); }
					else { send(400, { error: 'Git could not verify this repository.' }); }
					return;
				}
				if (root !== path) { send(400, { error: 'Select the Git repository root folder.' }); return; }
				send(200, { path, name: basename(path) });
			} else {
				const entries = await readdir(path, { withFileTypes: true });
				const directories = await Promise.all(entries.map(async (entry) => {
					const child = join(path, entry.name);
					if (entry.isDirectory()) return { name: entry.name, path: child };
					if (entry.isSymbolicLink()) {
						try { if ((await stat(child)).isDirectory()) return { name: entry.name, path: child }; } catch {}
					}
					return null;
				}));
				send(200, { path, parent: dirname(path) === path ? null : dirname(path), root: parse(path).root, entries: directories.filter(Boolean).sort((first, second) => first.name.localeCompare(second.name)) });
			}
		} catch (error) {
			send(error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 400, { error: error.code === 'EACCES' || error.code === 'EPERM' ? 'Access to this folder is not permitted.' : 'This folder is not available.' });
		}
		return;
	}
	const file = files.get(url.pathname);
	if (!file || !['GET', 'HEAD'].includes(request.method)) {
		response.writeHead(404).end();
		return;
	}
	try {
		const content = await readFile(new URL(`../design-explorations/${file[0]}`, import.meta.url));
		response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
		response.end(request.method === 'HEAD' ? undefined : content);
	} catch {
		response.writeHead(404).end();
	}
});
let port = Number(process.env.PORT || 5328);
server.on('error', (error) => {
	if (error.code === 'EADDRINUSE') {
		port += 1;
		server.listen(port, '127.0.0.1');
		return;
	}
	throw error;
});
server.on('listening', () => console.log(`Harness prototype: http://127.0.0.1:${port}/?variant=A`));
server.listen(port, '127.0.0.1');