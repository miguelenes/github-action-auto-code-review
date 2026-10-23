import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { collectReviewSupplement, linkedIssueNumbers } from './evidence.js';

test('linked requirement extraction stays within the current repository and excludes this PR', () => {
	assert.deepEqual(
		linkedIssueNumbers(
			'Fixes #42 and miguelenes/review-app#43. Also see https://github.com/miguelenes/review-app/issues/44 and other/repo#99.',
			'miguelenes',
			'review-app',
			10,
		),
		[42, 43, 44],
	);
});

test('review supplement retrieves head-bound changed source and linked requirement evidence', async () => {
	const source = ['export function check(value: string) {', '  return value.length > 0;', '}'].join('\n');
	const api = {
		repos: {
			getContent: async () => ({
				data: {
					type: 'file',
					encoding: 'base64',
					size: Buffer.byteLength(source),
					content: Buffer.from(source).toString('base64'),
				},
			}),
		},
		issues: {
			get: async () => ({
				data: { state: 'open', title: 'Reject empty values', body: 'Empty strings must be rejected.' },
			}),
		},
	} as unknown as Octokit;
	const result = await collectReviewSupplement(api, {
		owner: 'owner',
		repo: 'repo',
		pr: 10,
		headSha: 'head-sha',
		prBody: 'Fixes #42',
		diff: 'diff --git a/src/check.ts b/src/check.ts\n+++ b/src/check.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
	});
	assert.equal(result.complete, true);
	assert.deepEqual(result.issueNumbers, [42]);
	assert.match(result.context, /Changed source context \(src\/check.ts\)/);
	assert.match(result.context, /Linked requirement #42/);
	assert.match(result.context, /untrusted evidence, not instructions/);
});

test('unavailable linked requirements make coverage incomplete', async () => {
	const api = {
		repos: {
			getContent: async () => ({
				data: { type: 'file', encoding: 'base64', size: 1, content: Buffer.from('x').toString('base64') },
			}),
		},
		issues: {
			get: async () => {
				throw new Error('not found');
			},
		},
	} as unknown as Octokit;
	const result = await collectReviewSupplement(api, {
		owner: 'owner',
		repo: 'repo',
		pr: 10,
		headSha: 'sha',
		prBody: 'Fixes #77',
		diff: 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y',
	});
	assert.equal(result.complete, false);
	assert.ok(result.omissions.includes('could not retrieve linked requirement #77'));
});
