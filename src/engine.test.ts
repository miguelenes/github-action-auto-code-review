import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	independentReview,
	resumableIndependentReview,
	resumableProposeFixes,
	resumablePublishReview,
	resumableVerifyFixes,
	addedLines,
	anchorFindings,
	parseFilePatches,
	parseFindings,
	verifyFixes,
	type Model,
	type ReviewCheckpoint,
} from '@miguelenes/reviewer-engine';

const model = (id: string) => ({ provider: 'groq', id }) as Model;
const clock = { now: () => new Date('2026-01-02T03:04:05.000Z') };
const digest = { sha256: async (value: string) => createHash('sha256').update(value).digest('hex') };
const evidence = {
	severity: 'high',
	category: 'security',
	title: 'Missing authorization',
	path: 'src/route.ts',
	line: 8,
	evidence: 'The route accepts anonymous requests.',
	impact: 'Private data is exposed.',
	remediation: 'Require a signed-in user.',
};

test('runtime-neutral review stages use injected prompts and inference only', async () => {
	const calls: string[] = [];
	const result = await independentReview({
		diff: '+ vulnerable route',
		models: [model('reviewer'), model('security'), model('challenger')],
		rolePrompts: { reviewer: 'review prompt', challenger: 'challenge prompt' },
		clock,
		complete: async (selected, system) => {
			calls.push(`${selected.id}:${system}`);
			return selected.id === 'challenger' ? JSON.stringify([evidence]) : JSON.stringify([evidence]);
		},
	});
	assert.equal(result.findings.length, 1);
	assert.equal(result.findings[0]?.status, 'open');
	assert.equal(result.disputed, 0);
	assert.deepEqual(
		calls.map((call) => call.split(':')[0]),
		['reviewer', 'security', 'challenger'],
	);
});

test('portable findings and patches reject unsafe repository paths and oversized content', () => {
	assert.throws(() => parseFindings(JSON.stringify([{ ...evidence, path: '../secret' }])), /unsafe finding path/);
	assert.throws(
		() => parseFilePatches(JSON.stringify([{ path: '../secret', content: 'x' }]), new Set(['src/route.ts'])),
		/unsafe or out-of-scope/,
	);
	assert.throws(
		() =>
			parseFilePatches(
				JSON.stringify([{ path: 'src/route.ts', content: 'x'.repeat(500_001) }]),
				new Set(['src/route.ts']),
			),
		/unsafe or out-of-scope/,
	);
});

test('fix verification accepts only a schema-valid verifier response', async () => {
	const input = {
		findings: [],
		patches: [],
		sourceFiles: {},
		model: model('verifier'),
		rolePrompts: { verifier: 'verify' },
	};
	const response = (text: string) => verifyFixes({ ...input, complete: async () => text });

	assert.equal(await response('{"resolved":true,"reason":"All findings are fixed."}'), true);
	assert.equal(await response('{"resolved":"true","reason":"not a boolean"}'), false);
	assert.equal(await response('{"resolved":true}'), false);
	assert.equal(await response('not json'), false);
});

test('checkpointed reviews resume after reviewer work and invalidate checkpoints for a new head', async () => {
	const checkpoints = new Map<string, ReviewCheckpoint>();
	const persistence = {
		async getCheckpoint(jobId: string, stage: ReviewCheckpoint['stage']) {
			return checkpoints.get(`${jobId}:${stage}`);
		},
		async putCheckpoint(checkpoint: ReviewCheckpoint) {
			checkpoints.set(`${checkpoint.jobId}:${checkpoint.stage}`, checkpoint);
		},
	};
	let failChallenge = true;
	const firstCalls: string[] = [];
	const input = {
		jobId: 'job-1',
		headSha: 'head-1',
		diff: '+ vulnerable route',
		models: [model('reviewer'), model('security'), model('challenger')],
		rolePrompts: { reviewer: 'review prompt', challenger: 'challenge prompt' },
		persistence,
		clock,
		complete: async (selected: Pick<Model, 'provider' | 'id'>) => {
			firstCalls.push(selected.id);
			if (selected.id === 'challenger' && failChallenge) throw new Error('temporary provider failure');
			return JSON.stringify([evidence]);
		},
	};
	await assert.rejects(resumableIndependentReview(input), /temporary provider failure/);
	assert.deepEqual(firstCalls.sort(), ['challenger', 'reviewer', 'security']);
	assert.equal(checkpoints.has('job-1:review'), true);
	assert.equal(checkpoints.get('job-1:review')?.updatedAt, '2026-01-02T03:04:05.000Z');
	const secondCalls: string[] = [];
	failChallenge = false;
	const resumed = await resumableIndependentReview({
		...input,
		complete: async (selected: Pick<Model, 'provider' | 'id'>) => {
			secondCalls.push(selected.id);
			return JSON.stringify([evidence]);
		},
	});
	assert.deepEqual(secondCalls, ['challenger']);
	assert.equal(resumed.findings.length, 1);
	const newHeadCalls: string[] = [];
	await resumableIndependentReview({
		...input,
		headSha: 'head-2',
		complete: async (selected: Pick<Model, 'provider' | 'id'>) => {
			newHeadCalls.push(selected.id);
			return JSON.stringify([evidence]);
		},
	});
	assert.deepEqual(newHeadCalls.sort(), ['challenger', 'reviewer', 'security']);
});

test('fix, verification, and publication stages resume from head-bound checkpoints', async () => {
	const checkpoints = new Map<string, ReviewCheckpoint>();
	const persistence = {
		async getCheckpoint(jobId: string, stage: ReviewCheckpoint['stage']) {
			return checkpoints.get(`${jobId}:${stage}`);
		},
		async putCheckpoint(checkpoint: ReviewCheckpoint) {
			checkpoints.set(`${checkpoint.jobId}:${checkpoint.stage}`, checkpoint);
		},
	};
	const common = { jobId: 'job-2', headSha: 'head-1', persistence, clock, digest };
	let fixerCalls = 0;
	const fixInput = {
		...common,
		findings: [],
		diff: '+ changed',
		sourceFiles: { 'src/route.ts': 'before' },
		model: model('fixer'),
		allowed: new Set(['src/route.ts']),
		rolePrompts: { fixer: 'fix' },
		complete: async () => {
			fixerCalls++;
			return '[{"path":"src/route.ts","content":"after"}]';
		},
	};
	const firstPatches = await resumableProposeFixes(fixInput);
	const resumedPatches = await resumableProposeFixes({
		...fixInput,
		complete: async () => {
			throw new Error('cached fixes should not call inference');
		},
	});
	assert.deepEqual(resumedPatches, firstPatches);
	assert.equal(fixerCalls, 1);
	await resumableProposeFixes({
		...fixInput,
		sourceFiles: { 'src/route.ts': 'changed input' },
	});
	assert.equal(fixerCalls, 2);
	const cachedFix = checkpoints.get('job-2:fix')!;
	checkpoints.set('job-2:fix', {
		...cachedFix,
		payload: {
			...(cachedFix.payload as { inputDigest: string }),
			patches: [{ path: '../outside', content: 'unsafe cached patch' }],
		},
	});
	await resumableProposeFixes({
		...fixInput,
		sourceFiles: { 'src/route.ts': 'changed input' },
	});
	assert.equal(fixerCalls, 3);

	let verifierCalls = 0;
	const verifyInput = {
		...common,
		findings: [],
		patches: firstPatches,
		sourceFiles: fixInput.sourceFiles,
		model: model('verifier'),
		rolePrompts: { verifier: 'verify' },
		complete: async () => {
			verifierCalls++;
			return '{"resolved":true,"reason":"fixed"}';
		},
	};
	assert.equal(await resumableVerifyFixes(verifyInput), true);
	assert.equal(
		await resumableVerifyFixes({
			...verifyInput,
			complete: async () => {
				throw new Error('cached verification expected');
			},
		}),
		true,
	);
	assert.equal(verifierCalls, 1);
	assert.equal(
		await resumableVerifyFixes({
			...verifyInput,
			patches: [{ path: 'src/route.ts', content: 'different patch' }],
		}),
		true,
	);
	assert.equal(verifierCalls, 2);

	let publications = 0;
	const github = {
		async getCurrentHead() {
			return 'head-1';
		},
		async getBoundedDiff() {
			return '+ changed';
		},
		async publishReview() {
			publications++;
		},
	};
	const publishInput = {
		...common,
		repository: 'owner/repository',
		pullRequest: 42,
		findings: [],
		github,
	};
	await resumablePublishReview(publishInput);
	await resumablePublishReview(publishInput);
	assert.equal(publications, 1);
	await assert.rejects(
		resumablePublishReview({ ...publishInput, github: { ...github, getCurrentHead: async () => 'head-2' } }),
		/pull request head changed/,
	);

	let failedCheckpointWrite = true;
	const publicationKeys = new Set<string>();
	const failurePersistence = {
		...persistence,
		async putCheckpoint(checkpoint: ReviewCheckpoint) {
			if (checkpoint.stage === 'publish' && failedCheckpointWrite) {
				failedCheckpointWrite = false;
				throw new Error('checkpoint write failed after the GitHub write');
			}
			await persistence.putCheckpoint(checkpoint);
		},
	};
	const idempotentGithub = {
		...github,
		async publishReview(_repository: string, _pr: number, _sha: string, _findings: unknown[], key: string) {
			publicationKeys.add(key);
		},
	};
	const crashWindowInput = {
		...publishInput,
		jobId: 'job-3',
		persistence: failurePersistence,
		github: idempotentGithub,
	};
	await assert.rejects(resumablePublishReview(crashWindowInput), /checkpoint write failed/);
	await resumablePublishReview(crashWindowInput);
	assert.equal(publicationKeys.size, 1);
});

test('engine anchoring accepts only findings on added lines', () => {
	const anchors = addedLines(
		'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n unchanged\n-old\n+new\n',
	);
	const anchored = {
		id: 'finding',
		severity: 'high' as const,
		category: 'security' as const,
		title: 'Issue',
		path: 'src/a.ts',
		line: 2,
		evidence: 'evidence',
		impact: 'impact',
		remediation: 'fix',
		status: 'open' as const,
	};
	assert.deepEqual(anchorFindings([anchored], anchors), { valid: [anchored], rejected: 0 });
	assert.deepEqual(anchorFindings([{ ...anchored, line: 1 }], anchors), { valid: [], rejected: 1 });
});
