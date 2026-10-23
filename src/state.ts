import type { Octokit } from '@octokit/rest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ReviewCheckpoint, ReviewPersistence, ReviewStage } from '@miguelenes/reviewer-engine';
export type JournalEntry = {
	pr: number;
	sha: string;
	round: number;
	status: 'started' | 'complete' | 'needs-human';
	at: string;
	leaseUntil?: string;
	leaseId?: string;
	fixShas?: string[];
	forkRemediationAuthorized?: boolean;
	remediationPrs?: number[];
	checkpoints?: ReviewCheckpoint[];
};
type Journal = { version: 1; entries: JournalEntry[] };
const JournalEntrySchema = z
	.object({
		pr: z.number().int().positive(),
		sha: z.string().min(1).max(128),
		round: z.number().int().min(1).max(5),
		status: z.enum(['started', 'complete', 'needs-human']),
		at: z.string().datetime(),
		leaseUntil: z.string().datetime().optional(),
		leaseId: z.string().min(1).optional(),
		fixShas: z.array(z.string().min(1).max(128)).optional(),
		forkRemediationAuthorized: z.boolean().optional(),
		remediationPrs: z.array(z.number().int().positive()).optional(),
		checkpoints: z
			.array(
				z
					.object({
						jobId: z.string().min(1).max(256),
						headSha: z.string().min(1).max(128),
						stage: z.enum(['review', 'challenge', 'fix', 'verify', 'publish', 'complete', 'needs_human']),
						revision: z.number().int().positive(),
						payload: z.unknown(),
						updatedAt: z.string().datetime(),
					})
					.strict(),
			)
			.max(12)
			.optional(),
	})
	.strict();
const JournalSchema = z.object({ version: z.literal(1), entries: z.array(JournalEntrySchema) }).strict();
const branch = 'agent-review-state',
	ref = 'refs/heads/' + branch,
	file = 'journal.json';
const empty: Journal = { version: 1, entries: [] };
async function read(api: Octokit, owner: string, repo: string): Promise<{ sha: string; journal: Journal } | undefined> {
	try {
		const { data: r } = await api.git.getRef({ owner, repo, ref: 'heads/' + branch });
		const commit = await api.git.getCommit({ owner, repo, commit_sha: r.object.sha });
		const tree = await api.git.getTree({ owner, repo, tree_sha: commit.data.tree.sha });
		const item = tree.data.tree.find((x) => x.path === file);
		if (!item?.sha) return { sha: r.object.sha, journal: empty };
		const blob = await api.git.getBlob({ owner, repo, file_sha: item.sha });
		const parsed = JournalSchema.safeParse(JSON.parse(Buffer.from(blob.data.content, 'base64').toString()));
		if (!parsed.success) throw new Error('invalid review state journal');
		return { sha: r.object.sha, journal: parsed.data };
	} catch (e) {
		if ((e as { status?: number }).status === 404) return undefined;
		throw e;
	}
}
async function write(
	api: Octokit,
	owner: string,
	repo: string,
	prior: { sha: string; journal: Journal } | undefined,
	journal: Journal,
): Promise<void> {
	const blob = await api.git.createBlob({ owner, repo, content: JSON.stringify(journal), encoding: 'utf-8' });
	const tree = await api.git.createTree({
		owner,
		repo,
		tree: [{ path: file, mode: '100644', type: 'blob', sha: blob.data.sha }],
	});
	const commit = await api.git.createCommit({
		owner,
		repo,
		message: 'Update review round journal',
		tree: tree.data.sha,
		parents: prior ? [prior.sha] : [],
	});
	if (prior) await api.git.updateRef({ owner, repo, ref: 'heads/' + branch, sha: commit.data.sha, force: false });
	else await api.git.createRef({ owner, repo, ref, sha: commit.data.sha });
}
export async function reserveReviewRound(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	sha: string,
	maxRetries = 8,
	leaseMs = 60 * 60 * 1000,
	forceResume = false,
	resumeNeedsHuman = false,
): Promise<{ round: number; execute: false } | { round: number; execute: true; leaseId: string }> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const prior = await read(api, owner, repo),
			entries = prior?.journal.entries ?? [];
		const prEntries = entries.filter((e) => e.pr === pr);
		const existing = prEntries.find((e) => e.sha === sha || e.fixShas?.includes(sha));
		if (existing && existing.sha !== sha) return { round: existing.round, execute: false };
		if (existing && existing.status !== 'started' && !(resumeNeedsHuman && existing.status === 'needs-human'))
			return { round: existing.round, execute: false };
		const now = Date.now();
		if (!forceResume && existing?.leaseUntil && Date.parse(existing.leaseUntil) > now)
			return { round: existing.round, execute: false };
		const rounds = prEntries.length;
		if (!existing && rounds >= 5) throw new Error('five review rounds exhausted; needs-human');
		const round = existing?.round ?? rounds + 1,
			leaseUntil = new Date(now + leaseMs).toISOString();
		const leaseId = randomUUID();
		const nextEntry: JournalEntry = {
			...existing,
			pr,
			sha,
			round,
			status: 'started',
			at: new Date(now).toISOString(),
			leaseUntil,
			leaseId,
		};
		const nextEntries = existing
			? entries.map((e) => (e.pr === pr && e.sha === sha ? nextEntry : e))
			: [...entries, nextEntry];
		const journal: Journal = { version: 1, entries: nextEntries };
		try {
			await write(api, owner, repo, prior, journal);
			return { round, execute: true, leaseId };
		} catch (e) {
			const status = (e as { status?: number }).status;
			if (status === 409 || status === 422) continue;
			throw e;
		}
	}
	throw new Error('could not reserve review round after concurrent state updates');
}
export async function authorizeForkRemediation(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	sha: string,
	maxRetries = 8,
): Promise<void> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const prior = await read(api, owner, repo);
		if (!prior) throw new Error('review journal missing');
		const entries = [...prior.journal.entries],
			idx = entries.map((e) => e.pr === pr && e.sha === sha).lastIndexOf(true);
		if (idx < 0 || entries[idx]!.status !== 'needs-human')
			throw new Error('no idle needs-human review round exists for this pull request head');
		entries[idx] = { ...entries[idx]!, forkRemediationAuthorized: true, at: new Date().toISOString() };
		try {
			await write(api, owner, repo, prior, { version: 1, entries });
			return;
		} catch (e) {
			const code = (e as { status?: number }).status;
			if (code === 409 || code === 422) continue;
			throw e;
		}
	}
	throw new Error('could not record fork remediation authorization after concurrent state updates');
}
export async function forkRemediationAuthorized(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	sha: string,
	leaseId: string,
): Promise<boolean> {
	const current = await read(api, owner, repo);
	if (!current) throw new Error('review journal missing');
	const entry = current.journal.entries.find((e) => e.pr === pr && e.sha === sha && e.status === 'started');
	if (!entry || entry.leaseId !== leaseId) throw new Error('review lease was lost or superseded');
	return entry.forkRemediationAuthorized === true;
}
export async function attachRemediationPullRequest(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	sha: string,
	remediationPr: number,
	leaseId: string,
	maxRetries = 8,
): Promise<void> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const prior = await read(api, owner, repo);
		if (!prior) throw new Error('review journal missing');
		const entries = [...prior.journal.entries],
			idx = entries.findIndex((e) => e.pr === pr && e.sha === sha && e.status === 'started');
		if (idx < 0 || entries[idx]!.leaseId !== leaseId)
			throw new Error('active review round reservation missing or lease superseded');
		entries[idx] = {
			...entries[idx]!,
			remediationPrs: [...new Set([...(entries[idx]!.remediationPrs ?? []), remediationPr])],
			at: new Date().toISOString(),
		};
		try {
			await write(api, owner, repo, prior, { version: 1, entries });
			return;
		} catch (e) {
			const code = (e as { status?: number }).status;
			if (code === 409 || code === 422) continue;
			throw e;
		}
	}
	throw new Error('could not bind remediation pull request to its review round');
}
export async function isRemediationPullRequest(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
): Promise<boolean> {
	const current = await read(api, owner, repo);
	return current?.journal.entries.some((e) => e.remediationPrs?.includes(pr)) ?? false;
}
export async function refreshReviewLease(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	sha: string,
	round: number,
	leaseId: string,
	leaseMs = 60 * 60 * 1000,
	maxRetries = 8,
): Promise<void> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const prior = await read(api, owner, repo);
		if (!prior) throw new Error('review journal missing');
		const entries = [...prior.journal.entries],
			idx = entries.findIndex((e) => e.pr === pr && e.sha === sha && e.round === round && e.status === 'started');
		if (idx < 0 || entries[idx]!.leaseId !== leaseId) throw new Error('review lease was lost or superseded');
		const now = Date.now();
		if (!entries[idx]!.leaseUntil || Date.parse(entries[idx]!.leaseUntil!) <= now)
			throw new Error('review lease expired');
		entries[idx] = {
			...entries[idx]!,
			at: new Date(now).toISOString(),
			leaseUntil: new Date(now + leaseMs).toISOString(),
		};
		try {
			await write(api, owner, repo, prior, { version: 1, entries });
			return;
		} catch (e) {
			const code = (e as { status?: number }).status;
			if (code === 409 || code === 422) continue;
			throw e;
		}
	}
	throw new Error('could not refresh review lease after concurrent state updates');
}
export async function attachFixCommit(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	reviewSha: string,
	fixSha: string,
	leaseId: string,
	maxRetries = 8,
): Promise<void> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const prior = await read(api, owner, repo);
		if (!prior) throw new Error('review journal missing');
		const entries = [...prior.journal.entries],
			idx = entries.findIndex((e) => e.pr === pr && e.sha === reviewSha && e.status === 'started');
		if (idx < 0 || entries[idx]!.leaseId !== leaseId)
			throw new Error('active review round reservation missing or lease superseded');
		const entry = entries[idx]!,
			now = Date.now();
		if (!entry.leaseUntil || Date.parse(entry.leaseUntil) <= now)
			throw new Error('review lease expired before fix commit');
		const fixShas = [...new Set([...(entry.fixShas ?? []), fixSha])];
		entries[idx] = {
			...entry,
			fixShas,
			at: new Date(now).toISOString(),
			leaseUntil: new Date(now + 60 * 60 * 1000).toISOString(),
		};
		try {
			await write(api, owner, repo, prior, { version: 1, entries });
			return;
		} catch (e) {
			const code = (e as { status?: number }).status;
			if (code === 409 || code === 422) continue;
			throw e;
		}
	}
	throw new Error('could not bind fix commit to its review round');
}
export async function finishReviewRound(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	sha: string,
	leaseId: string,
	status: 'complete' | 'needs-human',
	maxRetries = 8,
): Promise<void> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const prior = await read(api, owner, repo);
		if (!prior) throw new Error('review journal missing');
		const entries = [...prior.journal.entries],
			idx = entries.map((e) => e.pr === pr && e.sha === sha).lastIndexOf(true);
		if (idx < 0 || entries[idx]!.leaseId !== leaseId)
			throw new Error('review round reservation missing or lease superseded');
		entries[idx] = { ...entries[idx]!, status, at: new Date().toISOString(), leaseUntil: undefined };
		try {
			await write(api, owner, repo, prior, { version: 1, entries });
			return;
		} catch (e) {
			const code = (e as { status?: number }).status;
			if (code === 409 || code === 422) continue;
			throw e;
		}
	}
	throw new Error('could not finalize review state after concurrent updates');
}

/** Persist bounded engine checkpoints on the repository's fenced state branch. */
export function createReviewPersistence(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	leaseId: string,
	maxRetries = 8,
): ReviewPersistence {
	const activeEntry = (entries: JournalEntry[]) =>
		entries.find((entry) => entry.pr === pr && entry.status === 'started' && entry.leaseId === leaseId);
	return {
		async getCheckpoint(jobId: string, stage: ReviewStage, headSha?: string) {
			const current = await read(api, owner, repo);
			if (!current) throw new Error('review journal missing while reading checkpoint');
			const entry = activeEntry(current.journal.entries);
			if (!entry) throw new Error('review lease was lost or superseded');
			return entry.checkpoints?.find(
				(checkpoint) =>
					checkpoint.jobId === jobId && checkpoint.stage === stage && (!headSha || checkpoint.headSha === headSha),
			);
		},
		async putCheckpoint(checkpoint: ReviewCheckpoint) {
			if (Buffer.byteLength(JSON.stringify(checkpoint)) > 750_000)
				throw new Error('review checkpoint exceeds the 750 KB state-branch limit');
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				const prior = await read(api, owner, repo);
				if (!prior) throw new Error('review journal missing while writing checkpoint');
				const entries = [...prior.journal.entries];
				const index = entries.findIndex(
					(entry) => entry.pr === pr && entry.status === 'started' && entry.leaseId === leaseId,
				);
				if (index < 0) throw new Error('review lease was lost or superseded');
				const entry = entries[index]!;
				const checkpoints = (entry.checkpoints ?? []).filter(
					(item) =>
						item.jobId !== checkpoint.jobId || item.stage !== checkpoint.stage || item.headSha !== checkpoint.headSha,
				);
				checkpoints.push(checkpoint);
				entries[index] = { ...entry, checkpoints: checkpoints.slice(-12) };
				try {
					await write(api, owner, repo, prior, { version: 1, entries });
					return;
				} catch (error) {
					const status = (error as { status?: number }).status;
					if (status === 409 || status === 422) continue;
					throw error;
				}
			}
			throw new Error('could not persist review checkpoint after concurrent state updates');
		},
	};
}
