import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { createForkRemediationPullRequest, validateCommit } from './executor.js';
import type { FilePatch } from './agents.js';

test('isolated validation dispatch uses the exact trusted base and tested head SHAs', async () => {
	let dispatch: { ref: string; inputs: Record<string, string> } | undefined;
	const api = {
		pulls: {
			async get() {
				return { data: { base: { ref: 'main', sha: 'base-sha' } } };
			},
		},
		actions: {
			async createWorkflowDispatch(input: { ref: string; inputs: Record<string, string> }) {
				dispatch = input;
				return { data: {} };
			},
			async listWorkflowRuns() {
				return {
					data: {
						workflow_runs: [
							{
								display_title: 'Validate PR 4 @ fix-sha',
								status: 'completed',
								conclusion: 'success',
								html_url: 'https://github.com/o/r/actions/runs/1',
							},
						],
					},
				};
			},
		},
	} as unknown as Octokit;
	const result = await validateCommit(
		api,
		{ owner: 'o', repo: 'r', pr: 4, sha: 'review-sha' },
		'fix-sha',
		1000,
		'validate-review.yml',
		['pnpm test'],
		'base-sha',
	);
	assert.equal(result.passed, true);
	assert.equal(dispatch?.ref, 'main');
	assert.deepEqual(dispatch?.inputs, {
		pull_number: '4',
		head_sha: 'fix-sha',
		base_ref: 'main',
		base_sha: 'base-sha',
		validation_commands: 'pnpm test',
	});
});

test('isolated validation refuses a base that changed after policy loading', async () => {
	let dispatched = false;
	const api = {
		pulls: {
			async get() {
				return { data: { base: { ref: 'main', sha: 'new-base' } } };
			},
		},
		actions: {
			async createWorkflowDispatch() {
				dispatched = true;
				return { data: {} };
			},
		},
	} as unknown as Octokit;
	await assert.rejects(
		validateCommit(
			api,
			{ owner: 'o', repo: 'r', pr: 4, sha: 'head' },
			'head',
			1000,
			'validate-review.yml',
			['pnpm test'],
			'trusted-base',
		),
		/trusted base changed/,
	);
	assert.equal(dispatched, false);
});
test('isolated validation reports failed CI as blocking instead of treating the dispatch as success', async () => {
	const api = {
		pulls: {
			async get() {
				return { data: { base: { ref: 'main', sha: 'base-sha' } } };
			},
		},
		actions: {
			async createWorkflowDispatch() {
				return { data: {} };
			},
			async listWorkflowRuns() {
				return {
					data: {
						workflow_runs: [
							{
								display_title: 'Validate PR 4 @ fix-sha',
								status: 'completed',
								conclusion: 'failure',
								html_url: 'https://github.com/o/r/actions/runs/2',
							},
						],
					},
				};
			},
		},
	} as unknown as Octokit;
	const result = await validateCommit(
		api,
		{ owner: 'o', repo: 'r', pr: 4, sha: 'review-sha' },
		'fix-sha',
		1000,
		'validate-review.yml',
		['pnpm test'],
		'base-sha',
	);
	assert.equal(result.passed, false);
	assert.equal(result.runUrl, 'https://github.com/o/r/actions/runs/2');
});

test('fork fixes create a draft bot PR, persist its shared-budget mapping, then mark it ready', async () => {
	const order: string[] = [],
		createdRefs: string[] = [];
	const pull = {
		head: { sha: 'fork-head', repo: { full_name: 'contributor/fork' } },
		base: { sha: 'base-sha', ref: 'main' },
	};
	const api = {
		paginate: async (fn: (args: unknown) => Promise<{ data: unknown[] }>, args: unknown) => (await fn(args)).data,
		pulls: {
			async get() {
				return { data: pull };
			},
			async listFiles() {
				return { data: [{ filename: 'src/file.ts' }] };
			},
			async create(args: { draft: boolean; head: string; base: string }) {
				order.push(`create:${args.draft}`);
				assert.equal(args.head.startsWith('owner:agent-review/pr-8-round-2-'), true);
				assert.equal(args.base, 'main');
				return { data: { number: 55, html_url: 'https://github.com/owner/repo/pull/55' } };
			},
			async update(args: { draft: boolean }) {
				order.push(`ready:${args.draft}`);
				return { data: {} };
			},
		},
		git: {
			async getCommit() {
				return { data: { tree: { sha: 'head-tree' } } };
			},
			async getTree() {
				return { data: { truncated: false, tree: [{ path: 'src/file.ts', mode: '100644' }] } };
			},
			async createBlob() {
				return { data: { sha: 'blob-sha' } };
			},
			async createTree() {
				return { data: { sha: 'tree-sha' } };
			},
			async createCommit() {
				return { data: { sha: 'fix-sha' } };
			},
			async createRef(args: { ref: string }) {
				createdRefs.push(args.ref);
				return { data: {} };
			},
			async deleteRef() {
				return { data: {} };
			},
		},
	} as unknown as Octokit;
	const result = await createForkRemediationPullRequest(
		api,
		{ owner: 'owner', repo: 'repo', pr: 8, sha: 'fork-head' },
		[{ path: 'src/file.ts', content: 'fixed' }] satisfies FilePatch[],
		2,
		async () => {
			order.push('fenced');
		},
		async (pr, sha, url) => {
			order.push(`mapped:${pr}:${sha}:${url}`);
		},
	);
	assert.deepEqual(result, { pr: 55, sha: 'fix-sha' });
	assert.equal(order.filter((item) => item === 'fenced').length, 6);
	assert.deepEqual(
		order.filter((item) => item !== 'fenced'),
		['create:true', 'mapped:55:fix-sha:https://github.com/owner/repo/pull/55', 'ready:false'],
	);
	assert.equal(createdRefs.length, 1);
	assert.match(createdRefs[0]!, /^refs\/heads\/agent-review\/pr-8-round-2-/);
});

test('fork remediation rejects unsafe paths before any GitHub writes', async () => {
	const api = {
		pulls: {
			async get() {
				throw new Error('should reject before API access');
			},
		},
	} as unknown as Octokit;
	await assert.rejects(
		createForkRemediationPullRequest(
			api,
			{ owner: 'owner', repo: 'repo', pr: 8, sha: 'head' },
			[{ path: '../escape', content: 'bad' }],
			1,
		),
		/unsafe repository path/,
	);
});
