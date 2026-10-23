import test from 'node:test';
import assert from 'node:assert/strict';
import {
	addedLines,
	anchorFindings,
	capabilityCandidates,
	selectReviewModels,
	publishSummary,
	publishFindingReview,
	publishAdditionalFindings,
} from './review.js';
import { ModelSchema, type Model } from './core.js';
test('diff evidence only anchors added lines', () => {
	const lines = addedLines('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n old\n+new\n same\n');
	assert.equal(lines.get('a.ts')?.has(2), true);
	assert.equal(lines.get('a.ts')?.has(1), false);
	assert.equal(lines.get('a.ts')?.has(3), false);
});
test('unanchored proposed findings remain visible as incomplete coverage', () => {
	const anchors = new Map([['a.ts', new Set([4])]]);
	const finding = {
		id: 'x',
		severity: 'high' as const,
		category: 'correctness' as const,
		title: 'Issue',
		path: 'a.ts',
		line: 3,
		evidence: 'x',
		impact: 'x',
		remediation: 'x',
		status: 'open' as const,
	};
	assert.deepEqual(anchorFindings([finding], anchors), { valid: [], rejected: 1 });
});
const candidate = (
	provider: 'openrouter' | 'groq' | 'gemini',
	id: string,
	codeReview: boolean | null = true,
): Model => {
	const observedAt = new Date().toISOString();
	const point = {
		sourceUrl: 'https://catalog.example/models',
		observedAt,
		claim: 'published zero price',
		usdPerMillion: 0,
	};
	return ModelSchema.parse({
		provider,
		id,
		context: 100_000,
		inputUsdPerMillion: 0,
		outputUsdPerMillion: 0,
		priceEvidence: { input: point, output: point, currency: 'USD', unit: 'per-million-tokens' },
		quotaEvidence: {
			sourceUrl: 'https://catalog.example/quota',
			observedAt,
			description: 'provider rejects requests above free limit without charge',
			noChargeAfterLimit: true,
		},
		...(provider === 'openrouter'
			? {}
			: {
					accountTierEvidence: {
						sourceUrl: 'https://catalog.example/account',
						observedAt,
						claim: 'verified free-tier account for this model',
					},
				}),
		capabilities: { chat: true, codeReview },
		trialExpiresAt: null,
		usageTerms: 'free access',
		termsEvidence:
			provider === 'openrouter'
				? null
				: { sourceUrl: 'https://catalog.example/terms', observedAt, claim: 'verified free-tier usage is permitted' },
		observedAt,
		sourceUrl: 'https://catalog.example/models',
	});
};
test('capability probes are bounded, context-fit, and spread across providers', () => {
	const now = new Date(Date.now() + 1000);
	const pool = [
		candidate('openrouter', 'or-a'),
		candidate('openrouter', 'or-b'),
		candidate('groq', 'groq-a'),
		candidate('gemini', 'gemini-a'),
		candidate('groq', 'too-small'),
	];
	pool[4]!.context = 10;
	const selected = capabilityCandidates(pool, ['or-b'], 100, now);
	assert.deepEqual(
		selected.map((model) => model.id),
		['or-b', 'gemini-a', 'groq-a', 'or-a'],
	);
	assert.equal(
		selected.some((model) => model.id === 'too-small'),
		false,
	);
	assert.ok(new Set(selected.slice(0, 3).map((model) => model.provider)).size >= 2);
});
test('review model selection honors context, spreads first reviewers, and preserves fixer/verifier choices', () => {
	const now = new Date(Date.now() + 1000);
	const models = [
		candidate('openrouter', 'or-a'),
		candidate('openrouter', 'or-b'),
		candidate('openrouter', 'or-c'),
		candidate('groq', 'groq-a'),
		candidate('gemini', 'gemini-a'),
	];
	const selected = selectReviewModels(models, ['or-b', 'groq-a'], 20_000, now);
	assert.deepEqual(
		selected.slice(0, 2).map((m) => m.id),
		['or-b', 'groq-a'],
	);
	assert.equal(selected.length, 5);
	assert.ok(new Set(selected.slice(0, 3).map((m) => m.provider)).size >= 2);
	assert.notEqual(selected[3]?.id, selected[0]?.id);
});
test('review model selection requires demonstrated capability, provider diversity, and enough context', () => {
	const now = new Date(Date.now() + 1000);
	assert.throws(
		() =>
			selectReviewModels(
				[candidate('openrouter', 'a'), candidate('openrouter', 'b'), candidate('openrouter', 'c')],
				[],
				100,
				now,
			),
		/passed the review capability check across at least two providers/,
	);
	assert.throws(
		() =>
			selectReviewModels(
				[candidate('openrouter', 'a'), candidate('groq', 'b', null), candidate('gemini', 'c')],
				[],
				100,
				now,
			),
		/passed the review capability check/,
	);
	const tooSmall = candidate('groq', 'small');
	tooSmall.context = 100;
	assert.throws(
		() => selectReviewModels([candidate('openrouter', 'a'), candidate('gemini', 'b'), tooSmall], [], 1_000, now),
		/sufficient context/,
	);
});
test('summary publishing updates its marker comment and refuses a stale head', async () => {
	let body = 'old';
	let updates = 0,
		creates = 0;
	const issues = {
		async listComments() {
			return { data: [{ id: 12, body: '<!-- open-source-agent-reviewer-summary --> old' }] };
		},
		async updateComment({ body: next }: { body: string }) {
			updates++;
			body = next;
			return { data: {} };
		},
		async createComment() {
			creates++;
			return { data: {} };
		},
	};
	const api = {
		paginate: async () => [{ id: 12, body: '<!-- open-source-agent-reviewer-summary --> old' }],
		pulls: {
			async get() {
				return { data: { head: { sha: 'head' } } };
			},
		},
		issues,
	} as never;
	await publishSummary(
		api,
		{ owner: 'o', repo: 'r', pr: 1, sha: 'head' },
		3,
		'openrouter/model, groq/model',
		[],
		'complete',
		true,
		'All review and verification steps completed.',
	);
	assert.equal(updates, 1);
	assert.equal(creates, 0);
	assert.match(body, /round 3\/5/);
	assert.match(body, /openrouter\/model/);
	const stale = {
		paginate: async () => [{ id: 12, body: '<!-- open-source-agent-reviewer-summary --> old' }],
		pulls: {
			async get() {
				return { data: { head: { sha: 'changed' } } };
			},
		},
		issues,
	} as never;
	await assert.rejects(
		publishSummary(stale, { owner: 'o', repo: 'r', pr: 1, sha: 'head' }, 3, '', [], 'complete', false, 'blocked'),
		/stale pull request head/,
	);
});
test('inline finding review publication is idempotent for a round and source head', async () => {
	const reviews: { commit_id: string; body: string }[] = [];
	let creates = 0;
	const api = {
		paginate: async () => reviews,
		pulls: {
			listReviews: async () => ({ data: reviews }),
			async createReview(input: { commit_id: string; body: string }) {
				creates++;
				reviews.push({ commit_id: input.commit_id, body: input.body });
				return { data: {} };
			},
		},
	} as never;
	const finding = {
		id: 'a.ts:2:issue',
		severity: 'high' as const,
		category: 'correctness' as const,
		title: 'Issue',
		path: 'a.ts',
		line: 2,
		evidence: 'line 2',
		impact: 'breaks the retry path',
		remediation: 'make it idempotent',
		status: 'open' as const,
	};
	await publishFindingReview(api, { owner: 'o', repo: 'r', pr: 1, sha: 'head-1' }, 1, 'model disclosure', [finding]);
	await publishFindingReview(api, { owner: 'o', repo: 'r', pr: 1, sha: 'head-1' }, 1, 'model disclosure', [finding]);
	assert.equal(creates, 1);
	assert.match(reviews[0]!.body, /open-source-agent-reviewer:1:head-1/);
	await publishFindingReview(api, { owner: 'o', repo: 'r', pr: 1, sha: 'head-2' }, 2, 'model disclosure', [finding]);
	assert.equal(creates, 2);
});
test('overflow findings update their marker comment instead of duplicating on retry', async () => {
	const comments: { id: number; body: string }[] = [];
	let creates = 0;
	let updates = 0;
	const api = {
		paginate: async () => comments,
		issues: {
			listComments: async () => ({ data: comments }),
			async createComment(input: { body: string }) {
				creates++;
				comments.push({ id: 1, body: input.body });
				return { data: {} };
			},
			async updateComment(input: { body: string }) {
				updates++;
				comments[0]!.body = input.body;
				return { data: {} };
			},
		},
	} as never;
	const finding = {
		id: 'a.ts:2:issue',
		severity: 'high' as const,
		category: 'correctness' as const,
		title: 'Issue',
		path: 'a.ts',
		line: 2,
		evidence: 'line 2',
		impact: 'breaks the retry path',
		remediation: 'make it idempotent',
		status: 'open' as const,
	};
	const target = { owner: 'o', repo: 'r', pr: 1, sha: 'head-1' };
	await publishAdditionalFindings(api, target, 1, [finding]);
	await publishAdditionalFindings(api, target, 1, [{ ...finding, impact: 'still breaks the retry path' }]);
	assert.equal(creates, 1);
	assert.equal(updates, 1);
	assert.match(comments[0]!.body, /still breaks the retry path/);
});
