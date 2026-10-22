import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import {
	reserveReviewRound,
	finishReviewRound,
	attachFixCommit,
	refreshReviewLease,
	authorizeForkRemediation,
	forkRemediationAuthorized,
	attachRemediationPullRequest,
	isRemediationPullRequest,
} from './state.js';
function fakeApi() {
	let head: string | undefined,
		sequence = 0;
	const blobs = new Map<string, string>(),
		trees = new Map<string, string>(),
		commits = new Map<string, { tree: { sha: string }; parents: string[] }>();
	const api = {
		git: {
			async getRef() {
				if (!head) throw Object.assign(new Error('missing'), { status: 404 });
				return { data: { object: { sha: head } } };
			},
			async createBlob({ content }: { content: string }) {
				const sha = 'b' + ++sequence;
				blobs.set(sha, content);
				return { data: { sha } };
			},
			async createTree({ tree }: { tree: { sha: string }[] }) {
				const sha = 't' + ++sequence;
				trees.set(sha, tree[0]!.sha);
				return { data: { sha } };
			},
			async createCommit({ tree, parents }: { tree: { sha: string }; parents: string[] }) {
				const sha = 'c' + ++sequence;
				commits.set(sha, { tree: { sha: tree as unknown as string }, parents });
				return { data: { sha } };
			},
			async createRef({ sha }: { sha: string }) {
				if (head) throw Object.assign(new Error('exists'), { status: 422 });
				head = sha;
				return { data: {} };
			},
			async updateRef({ sha, force }: { sha: string; force: boolean }) {
				const c = commits.get(sha);
				if (!c || (!force && c.parents[0] !== head)) throw Object.assign(new Error('conflict'), { status: 422 });
				head = sha;
				return { data: {} };
			},
			async getCommit({ commit_sha }: { commit_sha: string }) {
				const c = commits.get(commit_sha);
				if (!c) throw Object.assign(new Error('missing'), { status: 404 });
				return { data: { tree: c.tree } };
			},
			async getTree({ tree_sha }: { tree_sha: string }) {
				const blob = trees.get(tree_sha);
				return { data: { tree: blob ? [{ path: 'journal.json', sha: blob }] : [] } };
			},
			async getBlob({ file_sha }: { file_sha: string }) {
				return { data: { content: Buffer.from(blobs.get(file_sha) ?? '').toString('base64'), encoding: 'base64' } };
			},
		},
	};
	return api as unknown as Octokit;
}
test('review journal claims each new head once and enforces five PR rounds', async () => {
	const api = fakeApi();
	const first = await reserveReviewRound(api, 'o', 'r', 7, 'a');
	assert.equal(first.execute, true);
	if (!first.execute) return;
	const duplicate = await reserveReviewRound(api, 'o', 'r', 7, 'a');
	assert.deepEqual(duplicate, { round: 1, execute: false });
	const next = await reserveReviewRound(api, 'o', 'r', 7, 'b');
	assert.equal(next.execute, true);
	if (!next.execute) return;
	await finishReviewRound(api, 'o', 'r', 7, 'a', first.leaseId, 'complete');
	await reserveReviewRound(api, 'o', 'r', 7, 'c');
	await reserveReviewRound(api, 'o', 'r', 7, 'd');
	const fifth = await reserveReviewRound(api, 'o', 'r', 7, 'e');
	assert.equal(fifth.execute, true);
	if (!fifth.execute) return;
	const resumed = await reserveReviewRound(api, 'o', 'r', 7, 'e', 8, 60 * 60 * 1000, true);
	assert.equal(resumed.execute, true);
	if (!resumed.execute) return;
	assert.equal(resumed.round, 5);
	assert.notEqual(resumed.leaseId, fifth.leaseId);
	await assert.rejects(refreshReviewLease(api, 'o', 'r', 7, 'e', 5, fifth.leaseId), /superseded/);
	await refreshReviewLease(api, 'o', 'r', 7, 'e', 5, resumed.leaseId);
	await assert.rejects(reserveReviewRound(api, 'o', 'r', 7, 'f'), /five review rounds exhausted/);
});
test('concurrent duplicate deliveries produce one fenced review reservation', async () => {
	const api = fakeApi();
	const [a, b] = await Promise.all([
		reserveReviewRound(api, 'o', 'r', 3, 'same-head'),
		reserveReviewRound(api, 'o', 'r', 3, 'same-head'),
	]);
	assert.equal(Number(a.execute) + Number(b.execute), 1);
	const active = a.execute ? a : b;
	assert.equal(active.round, 1);
	if (active.execute) await refreshReviewLease(api, 'o', 'r', 3, 'same-head', 1, active.leaseId);
});
test('bot fix commit is bound to its existing review round lease', async () => {
	const api = fakeApi();
	const claim = await reserveReviewRound(api, 'o', 'r', 7, 'review-sha');
	assert.equal(claim.execute, true);
	if (!claim.execute) return;
	await attachFixCommit(api, 'o', 'r', 7, 'review-sha', 'bot-fix-sha', claim.leaseId);
	assert.deepEqual(await reserveReviewRound(api, 'o', 'r', 7, 'bot-fix-sha'), { round: 1, execute: false });
	const resumed = await reserveReviewRound(api, 'o', 'r', 7, 'review-sha', 8, 60 * 60 * 1000, true);
	assert.equal(resumed.execute, true);
	if (!resumed.execute) return;
	await assert.rejects(attachFixCommit(api, 'o', 'r', 7, 'review-sha', 'stale-fix-sha', claim.leaseId), /superseded/);
	await finishReviewRound(api, 'o', 'r', 7, 'review-sha', resumed.leaseId, 'complete');
	assert.deepEqual(await reserveReviewRound(api, 'o', 'r', 7, 'bot-fix-sha'), { round: 1, execute: false });
});
test('maintainer-authorized fork remediation resumes the same needs-human round and maps its bot PR', async () => {
	const api = fakeApi(),
		first = await reserveReviewRound(api, 'o', 'r', 21, 'fork-head');
	assert.equal(first.execute, true);
	if (!first.execute) return;
	await assert.rejects(authorizeForkRemediation(api, 'o', 'r', 21, 'fork-head'), /idle needs-human/);
	await finishReviewRound(api, 'o', 'r', 21, 'fork-head', first.leaseId, 'needs-human');
	await authorizeForkRemediation(api, 'o', 'r', 21, 'fork-head');
	const resumed = await reserveReviewRound(api, 'o', 'r', 21, 'fork-head', 8, 60 * 60 * 1000, true, true);
	assert.equal(resumed.execute, true);
	if (!resumed.execute) return;
	assert.equal(resumed.round, 1);
	assert.equal(await forkRemediationAuthorized(api, 'o', 'r', 21, 'fork-head', resumed.leaseId), true);
	await attachRemediationPullRequest(api, 'o', 'r', 21, 'fork-head', 34, resumed.leaseId);
	await attachRemediationPullRequest(api, 'o', 'r', 21, 'fork-head', 35, resumed.leaseId);
	assert.equal(await isRemediationPullRequest(api, 'o', 'r', 34), true);
	assert.equal(await isRemediationPullRequest(api, 'o', 'r', 35), true);
	assert.equal(await isRemediationPullRequest(api, 'o', 'r', 36), false);
	await finishReviewRound(api, 'o', 'r', 21, 'fork-head', resumed.leaseId, 'needs-human');
});
