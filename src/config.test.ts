import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, ModelSchema, type OpenRouterSpendGuard } from './core.js';
import {
	applyVerifiedFreeOffers,
	applyVerifiedTrialOffers,
	ReviewConfigSchema,
	defaultConfig,
	parseReviewConfig,
} from './config.js';

const now = new Date().toISOString();
const model = (provider: 'groq' | 'openrouter', id: string) =>
	ModelSchema.parse({
		provider,
		id,
		context: 100_000,
		inputUsdPerMillion: null,
		outputUsdPerMillion: null,
		priceEvidence: { input: null, output: null, currency: 'USD', unit: 'per-million-tokens' },
		quotaEvidence: null,
		capabilities: { chat: true, codeReview: null },
		usageTerms: 'catalog data',
		termsEvidence: null,
		observedAt: now,
		sourceUrl: 'https://provider.example/models',
	});
const offer = {
	provider: 'groq',
	modelId: 'llama-free',
	priceEvidence: {
		sourceUrl: 'https://console.groq.com/docs/pricing',
		observedAt: now,
		claim: 'This exact model is zero-priced on the Free plan.',
	},
	quotaEvidence: {
		sourceUrl: 'https://console.groq.com/docs/rate-limits',
		observedAt: now,
		description: 'The verified free account receives a 429 instead of paid usage when the quota is exhausted.',
		noChargeAfterLimit: true as const,
	},
	accountTierEvidence: {
		sourceUrl: 'https://console.groq.com/docs/billing-faqs',
		observedAt: now,
		claim: 'Operator verified the credential is on the Groq Free tier and has no paid billing method.',
	},
	termsEvidence: {
		sourceUrl: 'https://console.groq.com/docs/legal/services-agreement',
		observedAt: now,
		claim: 'Operator checked current terms and confirmed this review use is allowed.',
	},
};

test('policy defaults never enable repository writes or auto-merge', () => {
	assert.equal(defaultConfig.autoMerge, false);
	assert.equal(defaultConfig.automaticFixes, false);
	assert.equal(defaultConfig.mode, 'actions');
	assert.deepEqual(defaultConfig.verifiedFreeOffers, []);
});
test('policy rejects unlisted fields and malformed repository allowlists', () => {
	assert.throws(() => ReviewConfigSchema.parse({ unexpected: true }));
	assert.throws(() => ReviewConfigSchema.parse({ allowedRepositories: ['../bad'] }));
});
test('local configuration checks parse YAML and validate cross-field provider policy', () => {
	assert.equal(parseReviewConfig('mode: actions\nproviders: [openrouter]\nautoMerge: false').mode, 'actions');
	assert.throws(() =>
		parseReviewConfig('mode: actions\nproviders: [openrouter]\nverifiedFreeOffers: [{ provider: groq }]'),
	);
});
test('trusted free-tier evidence enables only the exact advertised non-OpenRouter model', () => {
	const config = ReviewConfigSchema.parse({ providers: ['openrouter', 'groq'], verifiedFreeOffers: [offer] });
	const models = [model('groq', 'llama-free'), model('groq', 'other-model'), model('openrouter', 'model:free')];
	const result = applyVerifiedFreeOffers(models, config.verifiedFreeOffers);
	assert.equal(result[0]?.inputUsdPerMillion, 0);
	assert.equal(result[0]?.accountTierEvidence?.claim, offer.accountTierEvidence.claim);
	assert.equal(eligible(result[0]!), true);
	assert.equal(result[1]?.inputUsdPerMillion, null);
	assert.equal(result[2]?.inputUsdPerMillion, null);
	const expired = ReviewConfigSchema.parse({
		providers: ['groq'],
		verifiedFreeOffers: [
			{ ...offer, accountTierEvidence: { ...offer.accountTierEvidence, observedAt: '2020-01-01T00:00:00.000Z' } },
		],
	});
	assert.equal(eligible(applyVerifiedFreeOffers([models[0]!], expired.verifiedFreeOffers)[0]!), false);
});

test('verified offers reject paid-fallback claims and OpenRouter overrides', () => {
	assert.throws(() => ReviewConfigSchema.parse({ verifiedFreeOffers: [{ ...offer, provider: 'openrouter' }] }));
	assert.throws(() =>
		ReviewConfigSchema.parse({
			verifiedFreeOffers: [{ ...offer, quotaEvidence: { ...offer.quotaEvidence, noChargeAfterLimit: false } }],
		}),
	);
});

test('verified OpenRouter trial offers require a fresh finite non-resetting key cap within the attested budget', () => {
	const trial = {
		provider: 'openrouter' as const,
		modelId: 'trial-model',
		trialCreditBudgetUsd: 10,
		trialExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		trialCreditEvidence: {
			sourceUrl: 'https://owner.example/trial',
			observedAt: now,
			claim: 'owner verified $10 trial credit',
		},
		termsEvidence: { sourceUrl: 'https://openrouter.ai/terms', observedAt: now, claim: 'owner verified current terms' },
	};
	const config = ReviewConfigSchema.parse({ providers: ['openrouter'], verifiedTrialOffers: [trial] });
	const catalog = ModelSchema.parse({
		provider: 'openrouter',
		id: 'trial-model',
		context: 100_000,
		inputUsdPerMillion: 0.25,
		outputUsdPerMillion: 0.5,
		priceEvidence: {
			input: {
				sourceUrl: 'https://openrouter.ai/api/v1/models',
				observedAt: now,
				claim: 'catalog input price',
				usdPerMillion: 0.25,
			},
			output: {
				sourceUrl: 'https://openrouter.ai/api/v1/models',
				observedAt: now,
				claim: 'catalog output price',
				usdPerMillion: 0.5,
			},
			currency: 'USD',
			unit: 'per-million-tokens',
		},
		quotaEvidence: null,
		capabilities: { chat: true, codeReview: true },
		usageTerms: 'catalog',
		termsEvidence: null,
		observedAt: now,
		sourceUrl: 'https://openrouter.ai/api/v1/models',
	});
	const guard: OpenRouterSpendGuard = {
		sourceUrl: 'https://openrouter.ai/api/v1/key',
		observedAt: now,
		isFreeTier: true,
		limitUsd: 8,
		remainingUsd: 7,
		limitReset: null,
		includeByokInLimit: true,
		expiresAt: trial.trialExpiresAt,
	};
	const prepared = applyVerifiedTrialOffers([catalog], config.verifiedTrialOffers, guard)[0]!;
	assert.equal(eligible(prepared), true);
	for (const unsafe of [
		{ ...guard, limitUsd: 11 },
		{ ...guard, remainingUsd: 0 },
		{ ...guard, limitReset: 'monthly' as const },
		{ ...guard, isFreeTier: false },
		{ ...guard, includeByokInLimit: false },
		{ ...guard, expiresAt: null },
	])
		assert.equal(eligible({ ...prepared, spendGuardEvidence: unsafe }), false);
	const stale = applyVerifiedTrialOffers([catalog], config.verifiedTrialOffers, {
		...guard,
		observedAt: '2020-01-01T00:00:00.000Z',
	})[0]!;
	assert.equal(eligible(stale), false);
	assert.throws(() =>
		ReviewConfigSchema.parse({ providers: ['openrouter'], verifiedTrialOffers: [trial, { ...trial }] }),
	);
	assert.throws(() => ReviewConfigSchema.parse({ providers: ['groq'], verifiedTrialOffers: [trial] }));
});
