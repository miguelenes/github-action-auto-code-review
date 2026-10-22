import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function unusedPort(): Promise<number> {
	const server = createNetServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
function signature(body: string, secret: string): string {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
async function waitForHealth(url: string, process: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt++) {
		if (process.exitCode !== null) throw new Error(`hosted server exited early (${process.exitCode})`);
		try {
			const response = await fetch(`${url}/healthz`);
			if (response.ok) return;
		} catch {
			// The server may not have opened its health listener yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('hosted server did not become healthy');
}

test('hosted webhook verifies signatures, durably deduplicates delivery, and drains cleanly', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'review-app-webhook-')),
		secret = 'fixture-webhook-secret',
		port = await unusedPort(),
		baseUrl = `http://127.0.0.1:${port}`,
		databasePath = join(directory, 'reviews.sqlite');
	const child = spawn(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: {
			PATH: process.env.PATH ?? '',
			PORT: String(port),
			STATE_DB: databasePath,
			GITHUB_WEBHOOK_SECRET: secret,
			NODE_ENV: 'test',
		},
		stdio: 'ignore',
	});
	try {
		await waitForHealth(baseUrl, child);
		const unauthenticated = await fetch(`${baseUrl}/webhook`, {
			method: 'POST',
			headers: { 'x-github-event': 'pull_request' },
			body: '{}',
		});
		assert.equal(unauthenticated.status, 401);
		const malformedBody = '{invalid json';
		const malformed = await fetch(`${baseUrl}/webhook`, {
			method: 'POST',
			headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': signature(malformedBody, secret) },
			body: malformedBody,
		});
		assert.equal(malformed.status, 400);
		const ignoredBody = '{}';
		const ignored = await fetch(`${baseUrl}/webhook`, {
			method: 'POST',
			headers: { 'x-github-event': 'ping', 'x-hub-signature-256': signature(ignoredBody, secret) },
			body: ignoredBody,
		});
		assert.equal(ignored.status, 202);
		assert.equal(await ignored.text(), 'ignored');
		const body = JSON.stringify({
			action: 'opened',
			repository: { full_name: 'owner/repo' },
			pull_request: { number: 42, draft: false, head: { sha: 'abc123' } },
		});
		for (let delivery = 0; delivery < 2; delivery++) {
			const response = await fetch(`${baseUrl}/webhook`, {
				method: 'POST',
				headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': signature(body, secret) },
				body,
			});
			assert.equal(response.status, 202);
		}
		const ready = await fetch(`${baseUrl}/readyz`);
		assert.equal(ready.status, 200);
		const db = new DatabaseSync(databasePath);
		let job: { state: string; round: number } | undefined;
		for (let attempt = 0; attempt < 80; attempt++) {
			job = db
				.prepare('SELECT state,round FROM jobs WHERE repository=? AND pr=? AND sha=?')
				.get('owner/repo', 42, 'abc123') as typeof job | undefined;
			if (job?.state === 'needs-human') break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const count = (
			db
				.prepare('SELECT count(*) AS count FROM jobs WHERE repository=? AND pr=? AND sha=?')
				.get('owner/repo', 42, 'abc123') as { count: number }
		).count;
		db.close();
		assert.equal(count, 1);
		assert.equal(job?.state, 'needs-human');
		assert.equal(job?.round, 1);
		child.kill('SIGTERM');
		const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
		assert.equal(code, 0, `unexpected exit signal ${signal}`);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
			if (child.exitCode === null) child.kill('SIGKILL');
		}
		rmSync(directory, { recursive: true, force: true });
	}
});
