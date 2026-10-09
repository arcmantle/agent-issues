import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

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
	const file = files.get(new URL(request.url, 'http://localhost').pathname);
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