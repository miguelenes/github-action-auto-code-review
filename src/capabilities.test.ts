import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelSchema, type Model } from './core.js';
import { assessReviewCapabilities, passesReviewCapability } from './capabilities.js';

const finding = JSON.stringify([
	{
		severity: 'high',
		category: 'security',
		title: 'Assignment grants every caller admin access',
		path: 'src/auth.ts',
		line: 2,
		evidence: "The condition assigns 'admin' instead of comparing the role.",
		impact: 'Any caller can gain administrator access.',
		remediation: 'Use strict equality for the role check.',
	},
]);
const fixtureModel = (provider: 'openrouter' | 'groq', id: string): Model => {
	const observedAt = new Date().toISOString(),
		point = { sourceUrl: 'https://catalog.example/models', observedAt, claim: 'zero cost', usdPerMillion: 0 };
	return ModelSchema.parse({
		provider,
		id,
		context: 10000,
		inputUsdPerMillion: 0,
		outputUsdPerMillion: 0,
		priceEvidence: { input: point, output: point, currency: 'USD', unit: 'per-million-tokens' },
		quotaEvidence: {
			sourceUrl: 'https://catalog.example/quota',
			observedAt,
			description: 'fails at free quota',
			noChargeAfterLimit: true,
		},
		...(provider === 'groq'
			? {
					accountTierEvidence: {
						sourceUrl: 'https://catalog.example/account',
						observedAt,
						claim: 'verified free account',
					},
				}
			: {}),
		capabilities: { chat: true, codeReview: null },
		usageTerms: 'free',
		termsEvidence:
			provider === 'groq' ? { sourceUrl: 'https://catalog.example/terms', observedAt, claim: 'permitted' } : null,
		observedAt,
		sourceUrl: 'https://catalog.example/models',
	});
};

test('capability requires the known authorization bug and rejects false positives on correct code', () => {
	assert.equal(passesReviewCapability(finding, '[]'), true);
	assert.equal(passesReviewCapability('[]', '[]'), false);
	assert.equal(passesReviewCapability(finding, finding), false);
	assert.equal(passesReviewCapability('not JSON', '[]'), false);
	assert.equal(
		passesReviewCapability(
			JSON.stringify([...JSON.parse(finding), { ...JSON.parse(finding)[0], path: 'src/other.ts' }]),
			'[]',
		),
		false,
	);
	const unanchored = JSON.stringify([{ ...JSON.parse(finding)[0], line: 3 }]);
	assert.equal(passesReviewCapability(unanchored, '[]'), false);
});

test('assessment sends only fixed synthetic probes and marks failures as not capable', async () => {
	const calls: string[] = [],
		model = fixtureModel('openrouter', 'fixture-model');
	const [assessed] = await assessReviewCapabilities([model], async (_model, _system, prompt) => {
		calls.push(prompt);
		return prompt.includes("user.role = 'admin'") ? finding : '[]';
	});
	assert.equal(assessed?.capabilities.codeReview, true);
	assert.equal(calls.length, 2);
	assert.match(calls[0]!, /src\/auth\.ts/);
	assert.match(calls[0]!, /user\.role = 'admin'/);
	assert.match(calls[1]!, /user\.role === 'admin'/);
	assert.ok(calls.every((prompt) => prompt.includes('synthetic code diff')));
	assert.ok(calls.every((prompt) => !prompt.includes('known bug') && !prompt.includes('this case is correct')));
	const [failed] = await assessReviewCapabilities([model], async () => {
		throw new Error('provider throttled');
	});
	assert.equal(failed?.capabilities.codeReview, false);
});
