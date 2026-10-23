import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, ModelSchema, nextRound, mergeReady, type Model, type ReviewRound } from './core.js';
const model = (price: number | null): Model => {
	const at = new Date().toISOString();
	return {
		provider: 'openrouter',
		id: 'example:free',
		inputUsdPerMillion: price,
		outputUsdPerMillion: price,
		priceEvidence: {
			input:
				price === null
					? null
					: {
							sourceUrl: 'https://example.com/pricing',
							observedAt: at,
							claim: 'catalog states zero',
							usdPerMillion: price,
						},
			output:
				price === null
					? null
					: {
							sourceUrl: 'https://example.com/pricing',
							observedAt: at,
							claim: 'catalog states zero',
							usdPerMillion: price,
						},
			currency: 'USD',
			unit: 'per-million-tokens',
		},
		quotaEvidence: {
			sourceUrl: 'https://example.com/limits',
			observedAt: at,
			description: 'free tier rejects over-quota requests',
			noChargeAfterLimit: true,
		},
		capabilities: { chat: true, codeReview: null },
		usageTerms: 'free tier',
		termsEvidence: null,
		observedAt: at,
		sourceUrl: 'https://example.com',
	};
};
test('eligibility requires fresh known zero prices, quota, account tier, and terms evidence', () => {
	const now = new Date(Date.now() + 1000);
	assert.equal(eligible(model(0), now), true);
	assert.equal(eligible(model(null), now), false);
	assert.equal(eligible(model(1), now), false);
	const unsafe = model(0);
	unsafe.quotaEvidence!.noChargeAfterLimit = false;
	assert.equal(eligible(unsafe, now), false);
	const unknownQuota = model(0);
	unknownQuota.quotaEvidence = null;
	assert.equal(eligible(unknownQuota, now), false);
	const stale = model(0);
	stale.priceEvidence.input!.observedAt = '2020-01-01T00:00:00.000Z';
	assert.equal(eligible(stale, now), false);
	const future = model(0);
	future.quotaEvidence!.observedAt = new Date(now.getTime() + 60000).toISOString();
	assert.equal(eligible(future, now), false);
	const trial = model(0);
	trial.trialExpiresAt = '2020-01-01T00:00:00.000Z';
	assert.equal(eligible(trial, now), false);
	const direct = ModelSchema.parse({ ...model(0), provider: 'groq' });
	assert.equal(eligible(direct, now), false);
	direct.accountTierEvidence = {
		sourceUrl: 'https://example.com/tier',
		observedAt: now.toISOString(),
		claim: 'owner verified free account',
	};
	assert.equal(eligible(direct, now), false);
	direct.termsEvidence = {
		sourceUrl: 'https://example.com/terms',
		observedAt: now.toISOString(),
		claim: 'owner verified permitted use',
	};
	assert.equal(eligible(direct, now), true);
	direct.accountTierEvidence.observedAt = '2020-01-01T00:00:00.000Z';
	assert.equal(eligible(direct, now), false);
});
test('price evidence must match normalized prices', () => {
	const inconsistent = {
		...model(0),
		priceEvidence: { ...model(0).priceEvidence, input: { ...model(0).priceEvidence.input!, usdPerMillion: 1 } },
	};
	assert.equal(ModelSchema.safeParse(inconsistent).success, false);
});
test('round budget terminates at five', () => {
	const r: ReviewRound = {
		pr: 1,
		headSha: 'abc',
		round: 5,
		phase: 'needs-human',
		coverage: 'incomplete',
		findings: [],
		models: [],
	};
	assert.throws(() => nextRound(r, 'def'), /exhausted/);
});
test('merge readiness requires complete evidence, successful checks, resolved findings, and no disputes', () => {
	const r: ReviewRound = {
		pr: 1,
		headSha: 'abc',
		round: 1,
		phase: 'complete',
		coverage: 'complete',
		findings: [],
		models: [],
	};
	assert.equal(mergeReady(r, true), true);
	r.coverage = 'incomplete';
	assert.equal(mergeReady(r, true), false);
	r.coverage = 'complete';
	r.disputed = 1;
	assert.equal(mergeReady(r, true), false);
	r.disputed = 0;
	assert.equal(mergeReady(r, false), false);
	r.findings = [
		{
			id: '1',
			severity: 'high',
			category: 'security',
			title: 'open finding',
			path: 'a.ts',
			line: 1,
			evidence: 'x',
			impact: 'x',
			remediation: 'x',
			status: 'open',
		},
	];
	assert.equal(mergeReady(r, true), false);
	r.findings[0]!.status = 'fixed';
	assert.equal(mergeReady(r, true), true);
});
