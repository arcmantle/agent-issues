import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request, type OutgoingHttpHeaders } from 'node:http';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { handlePrototypeApi } from './prototype-api.js';

const server = createServer((incoming, response) => {
	void handlePrototypeApi(incoming, response, () => response.writeHead(404).end());
});
let port = 0;

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No test server address.');
	port = address.port;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
});

function send(path: string, headers: OutgoingHttpHeaders = {}, method = 'GET') {
	return new Promise<{ code: number; body: string }>((resolve, reject) => {
		const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => {
				body += chunk;
			});
			response.on('end', () => resolve({ code: response.statusCode ?? 0, body }));
		});
		outgoing.on('error', reject);
		outgoing.end();
	});
}

describe('Read-only prototype APIs', () => {
	it('permits same-origin folder reads and repository verification', async () => {
		const root = (await promisify(execFile)('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
		const query = `?path=${encodeURIComponent(root)}`;
		expect((await send(`/api/folders${query}`, { Origin: `http://127.0.0.1:${port}` })).code).toBe(
			200
		);
		expect((await send(`/api/repository${query}`)).code).toBe(200);
		expect((await send('/api/folders?path=relative')).code).toBe(400);
		expect(
			(
				await send(
					`/api/repository?path=${encodeURIComponent(join(root, 'design-explorations', 'harness'))}`
				)
			).code
		).toBe(400);
	});

	it('rejects writes, forged hosts, and cross-site requests', async () => {
		expect((await send('/api/folders', {}, 'POST')).code).toBe(405);
		expect((await send('/api/folders', { Host: 'other.example' })).code).toBe(403);
		expect((await send('/api/folders', { Origin: 'https://other.example' })).code).toBe(403);
		expect((await send('/api/folders', { 'Sec-Fetch-Site': 'cross-site' })).code).toBe(403);
	});
});
