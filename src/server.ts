import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { verifySignature, installationOctokit } from './github.js';
import { reviewPullRequest } from './review.js';
import { authorizeForkRemediation, isRemediationPullRequest, reserveReviewRound, finishReviewRound } from './state.js';
import { authorizeForkRemediationRequest, isForkRemediationCommand } from './remediation-command.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
const dbPath = process.env.STATE_DB ?? 'data/reviews.sqlite';
mkdirSync(join(dbPath, '..'), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(
	`CREATE TABLE IF NOT EXISTS jobs(repository TEXT NOT NULL, pr INTEGER NOT NULL, sha TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, updated_at TEXT NOT NULL, resume_round INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repository,pr,sha));`,
);
if (
	!(db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).some((column) => column.name === 'resume_round')
)
	db.exec('ALTER TABLE jobs ADD COLUMN resume_round INTEGER NOT NULL DEFAULT 0');
db.prepare("UPDATE jobs SET state='recovering',updated_at=? WHERE state='running'").run(new Date().toISOString());
const enqueue = db.prepare(
	`INSERT OR IGNORE INTO jobs(repository,pr,sha,round,state,updated_at) VALUES(?,?,?,0,'queued',?)`,
);
const setState = db.prepare(
	'UPDATE jobs SET state=?,round=round+?,updated_at=?,resume_round=0 WHERE repository=? AND pr=? AND sha=?',
);
const pending = db.prepare(
	"SELECT repository,pr,sha,state,resume_round FROM jobs WHERE state IN('queued','recovering') LIMIT 1",
);
const findJob = db.prepare('SELECT state FROM jobs WHERE repository=? AND pr=? AND sha=?');
const resumeJob = db.prepare(
	"UPDATE jobs SET state='queued',resume_round=1,updated_at=? WHERE repository=? AND pr=? AND sha=? AND state IN('needs-human','queued','recovering')",
);
const insertResumeJob = db.prepare(
	"INSERT OR IGNORE INTO jobs(repository,pr,sha,round,state,updated_at,resume_round) VALUES(?,?,?,0,'queued',?,1)",
);
let working = false,
	ready = true,
	shuttingDown = false;
async function drain() {
	if (working) return;
	working = true;
	try {
		for (;;) {
			const row = pending.get() as
				| { repository: string; pr: number; sha: string; state: 'queued' | 'recovering'; resume_round: number }
				| undefined;
			if (!row) break;
			const [owner, repo] = row.repository.split('/');
			if (!owner || !repo) {
				setState.run('failed', 0, new Date().toISOString(), row.repository, row.pr, row.sha);
				continue;
			}
			const lock = db
				.prepare(
					"UPDATE jobs SET state='running',updated_at=? WHERE repository=? AND pr=? AND sha=? AND state IN('queued','recovering')",
				)
				.run(new Date().toISOString(), row.repository, row.pr, row.sha);
			if (!lock.changes) continue;
			try {
				const id = Number(process.env.GITHUB_INSTALLATION_ID);
				if (!id) throw new Error('GITHUB_INSTALLATION_ID is required');
				const api = await installationOctokit(id, row.repository);
				const current = await api.pulls.get({ owner, repo, pull_number: row.pr });
				if (current.data.head.sha !== row.sha) {
					setState.run('ignored', 0, new Date().toISOString(), row.repository, row.pr, row.sha);
					continue;
				}
				if (await isRemediationPullRequest(api, owner, repo, row.pr)) {
					setState.run('ignored', 0, new Date().toISOString(), row.repository, row.pr, row.sha);
					continue;
				}
				const reservation = await reserveReviewRound(
					api,
					owner,
					repo,
					row.pr,
					row.sha,
					8,
					60 * 60 * 1000,
					row.state === 'recovering' || row.resume_round === 1,
					row.resume_round === 1,
				);
				if (!reservation.execute) {
					setState.run('ignored', 0, new Date().toISOString(), row.repository, row.pr, row.sha);
					continue;
				}
				try {
					const result = await reviewPullRequest(
						api,
						{ owner, repo, pr: row.pr, sha: row.sha },
						'hosted',
						reservation.round,
						reservation.leaseId,
					);
					await finishReviewRound(
						api,
						owner,
						repo,
						row.pr,
						row.sha,
						reservation.leaseId,
						result.resolved ? 'complete' : 'needs-human',
					);
					setState.run(
						result.resolved ? 'complete' : 'needs-human',
						1,
						new Date().toISOString(),
						row.repository,
						row.pr,
						row.sha,
					);
				} catch (e) {
					await finishReviewRound(api, owner, repo, row.pr, row.sha, reservation.leaseId, 'needs-human').catch(
						() => {},
					);
					throw e;
				}
			} catch {
				setState.run('needs-human', 1, new Date().toISOString(), row.repository, row.pr, row.sha);
			}
		}
	} catch {
		ready = false;
	} finally {
		working = false;
	}
}
const PullRequestWebhookSchema = z
	.object({
		action: z.string(),
		repository: z.object({ full_name: z.string() }),
		pull_request: z
			.object({
				number: z.number().int().positive(),
				draft: z.boolean(),
				head: z.object({ sha: z.string().min(1) }).passthrough(),
			})
			.passthrough(),
	})
	.passthrough();
const IssueCommentWebhookSchema = z
	.object({
		action: z.string(),
		repository: z.object({ full_name: z.string() }),
		issue: z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }).passthrough(),
		comment: z.object({ body: z.unknown() }).passthrough(),
		sender: z.object({ login: z.string().min(1) }).passthrough(),
	})
	.passthrough();
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
async function handleWebhook(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret || !verifySignature(secret, body, req.headers['x-hub-signature-256'])) {
		res.writeHead(401).end();
		return;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(body.toString('utf8'));
	} catch {
		res.writeHead(400).end();
		return;
	}
	const event = String(req.headers['x-github-event'] ?? '');
	if (event === 'pull_request') {
		const parsed = PullRequestWebhookSchema.safeParse(payload);
		if (!parsed.success) {
			res.writeHead(400).end('invalid pull request payload');
			return;
		}
		const data = parsed.data;
		if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(data.action) || data.pull_request.draft) {
			res.writeHead(202).end('ignored');
			return;
		}
		const repository = data.repository.full_name;
		if (!repositoryPattern.test(repository)) {
			res.writeHead(400).end('invalid repository');
			return;
		}
		enqueue.run(repository, data.pull_request.number, data.pull_request.head.sha, new Date().toISOString());
		res.writeHead(202).end('queued');
		void drain();
		return;
	}
	if (event === 'issue_comment') {
		const parsed = IssueCommentWebhookSchema.safeParse(payload);
		if (!parsed.success) {
			res.writeHead(400).end('invalid issue comment payload');
			return;
		}
		const data = parsed.data;
		if (data.action !== 'created' || !data.issue.pull_request || !isForkRemediationCommand(data.comment.body)) {
			res.writeHead(202).end('ignored');
			return;
		}
		const repository = data.repository.full_name;
		if (!repositoryPattern.test(repository)) {
			res.writeHead(400).end('invalid repository');
			return;
		}
		const [owner, repo] = repository.split('/');
		if (!owner || !repo) {
			res.writeHead(400).end('invalid repository');
			return;
		}
		try {
			const installation = Number(process.env.GITHUB_INSTALLATION_ID);
			if (!Number.isSafeInteger(installation) || installation < 1) throw new Error('invalid installation');
			const api = await installationOctokit(installation, repository);
			if (await isRemediationPullRequest(api, owner, repo, data.issue.number)) {
				res.writeHead(202).end('ignored');
				return;
			}
			const authorized = await authorizeForkRemediationRequest(api, owner, repo, data.issue.number, data.sender.login);
			await authorizeForkRemediation(api, owner, repo, data.issue.number, authorized.sha);
			const existing = findJob.get(repository, data.issue.number, authorized.sha) as { state: string } | undefined,
				now = new Date().toISOString();
			if (existing && ['needs-human', 'queued', 'recovering'].includes(existing.state)) {
				const resumed = resumeJob.run(now, repository, data.issue.number, authorized.sha);
				if (!resumed.changes) throw new Error('review job changed before remediation could be queued');
			} else if (existing) throw new Error('review must be idle in needs-human state before remediation can resume');
			else insertResumeJob.run(repository, data.issue.number, authorized.sha, now);
			res.writeHead(202).end('authorized and queued');
			void drain();
			return;
		} catch (error) {
			console.warn('fork remediation command was rejected', error instanceof Error ? error.message : 'unknown error');
			res.writeHead(202).end('command rejected; review state was not queued');
			return;
		}
	}
	res.writeHead(202).end('ignored');
}
const server = createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/healthz') {
		res.writeHead(200).end('ok');
		return;
	}
	if (req.method === 'GET' && req.url === '/readyz') {
		const ok = ready && !shuttingDown && Boolean(db.prepare('SELECT 1').get());
		res.writeHead(ok ? 200 : 503).end(ok ? 'ready' : 'not ready');
		return;
	}
	if (req.method !== 'POST' || req.url !== '/webhook') {
		res.writeHead(404).end();
		return;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	req.on('data', (chunk: Buffer) => {
		size += chunk.length;
		if (size > 1024 * 1024) {
			res.writeHead(413).end();
			req.destroy();
		} else chunks.push(chunk);
	});
	req.on('end', () => {
		void handleWebhook(req, res, Buffer.concat(chunks)).catch((error) => {
			console.error('webhook processing failed', error instanceof Error ? error.message : 'unknown error');
			if (!res.headersSent) res.writeHead(500).end('webhook processing failed');
		});
	});
});
server.listen(Number(process.env.PORT ?? 3000), () => {
	console.log('webhook listener ready');
	void drain();
});
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	ready = false;
	console.log(`${signal} received; draining review queue`);
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	while (working) await new Promise((resolve) => setTimeout(resolve, 100));
	db.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.once(signal, () => {
		void shutdown(signal).catch((error) => {
			console.error('graceful shutdown failed', error);
			process.exitCode = 1;
			db.close();
		});
	});
