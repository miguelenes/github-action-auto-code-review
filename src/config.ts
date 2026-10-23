import { z } from 'zod';
import { parse } from 'yaml';
import { EvidenceSchema, Providers, type OpenRouterSpendGuard } from './core.js';
import type { Octokit } from '@octokit/rest';
export const defaultValidationCommands = Object.freeze([
	'pnpm --dir untrusted install --frozen-lockfile --ignore-scripts',
	'pnpm --dir untrusted build',
	'pnpm --dir untrusted test',
]);
const ZeroCostOfferSchema = z
	.object({
		provider: z.enum(Providers).refine((provider) => provider !== 'openrouter' && provider !== 'github-models'),
		modelId: z.string().trim().min(1),
		priceEvidence: z.object({
			sourceUrl: z.string().url(),
			observedAt: z.string().datetime(),
			claim: z.string().min(1),
		}),
		quotaEvidence: z.object({
			sourceUrl: z.string().url(),
			observedAt: z.string().datetime(),
			description: z.string().min(1),
			noChargeAfterLimit: z.literal(true),
		}),
		accountTierEvidence: z.object({
			sourceUrl: z.string().url(),
			observedAt: z.string().datetime(),
			claim: z.string().min(1),
		}),
		termsEvidence: z.object({
			sourceUrl: z.string().url(),
			observedAt: z.string().datetime(),
			claim: z.string().min(1),
		}),
	})
	.strict();
const VerifiedTrialOfferSchema = z
	.object({
		provider: z.literal('openrouter'),
		modelId: z.string().trim().min(1),
		trialCreditBudgetUsd: z.number().positive(),
		trialExpiresAt: z.string().datetime(),
		trialCreditEvidence: EvidenceSchema,
		termsEvidence: EvidenceSchema,
	})
	.strict();
export const ReviewConfigSchema = z
	.object({
		mode: z.enum(['hosted', 'actions']).default('actions'),
		providers: z.array(z.enum(Providers)).default(['openrouter']),
		verifiedFreeOffers: z.array(ZeroCostOfferSchema).default([]),
		verifiedTrialOffers: z.array(VerifiedTrialOfferSchema).default([]),
		preferredModels: z.array(z.string()).default([]),
		allowedRepositories: z
			.array(z.string().regex(/^(?=.{3,201}$)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/))
			.default([]),
		automaticFixes: z.boolean().default(false),
		autoMerge: z.boolean().default(false),
		mergeMethod: z.enum(['MERGE', 'SQUASH', 'REBASE']).default('SQUASH'),
		validationWorkflow: z.string().default('validate-review.yml'),
		validationCommands: z
			.array(z.string().min(1).max(2000))
			.min(1)
			.max(10)
			.default([...defaultValidationCommands]),
		validationTimeoutSeconds: z.number().int().min(60).max(1800).default(300),
	})
	.strict()
	.superRefine((config, ctx) => {
		const seen = new Set<string>();
		config.verifiedFreeOffers.forEach((offer, index) => {
			const key = `${offer.provider}:${offer.modelId}`;
			if (seen.has(key))
				ctx.addIssue({
					code: 'custom',
					path: ['verifiedFreeOffers', index, 'modelId'],
					message: 'duplicate verified offer for this provider/model',
				});
			seen.add(key);
			if (!config.providers.includes(offer.provider))
				ctx.addIssue({
					code: 'custom',
					path: ['verifiedFreeOffers', index, 'provider'],
					message: 'verified offer provider must also be enabled',
				});
		});
		config.verifiedTrialOffers.forEach((offer, index) => {
			const key = `${offer.provider}:${offer.modelId}`;
			if (seen.has(key))
				ctx.addIssue({
					code: 'custom',
					path: ['verifiedTrialOffers', index, 'modelId'],
					message: 'duplicate verified offer for this provider/model',
				});
			seen.add(key);
			if (!config.providers.includes(offer.provider))
				ctx.addIssue({
					code: 'custom',
					path: ['verifiedTrialOffers', index, 'provider'],
					message: 'verified trial provider must also be enabled',
				});
		});
	});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export function parseReviewConfig(source: string): ReviewConfig {
	return ReviewConfigSchema.parse(parse(source));
}
export function applyVerifiedFreeOffers(
	models: import('./core.js').Model[],
	offers: ReviewConfig['verifiedFreeOffers'],
): import('./core.js').Model[] {
	const byKey = new Map(offers.map((offer) => [`${offer.provider}:${offer.modelId}`, offer]));
	return models.map((model) => {
		if (model.provider === 'openrouter') return model;
		const offer = byKey.get(`${model.provider}:${model.id}`);
		if (!offer) return model;
		const point = (evidence: typeof offer.priceEvidence) => ({ ...evidence, usdPerMillion: 0 });
		return {
			...model,
			inputUsdPerMillion: 0,
			outputUsdPerMillion: 0,
			priceEvidence: {
				input: point(offer.priceEvidence),
				output: point(offer.priceEvidence),
				currency: 'USD' as const,
				unit: 'per-million-tokens' as const,
			},
			quotaEvidence: offer.quotaEvidence,
			accountTierEvidence: offer.accountTierEvidence,
			termsEvidence: offer.termsEvidence,
			usageTerms: `Owner-verified zero-cost account tier: ${offer.termsEvidence.claim}`,
		};
	});
}
export function applyVerifiedTrialOffers(
	models: import('./core.js').Model[],
	offers: ReviewConfig['verifiedTrialOffers'],
	guard: OpenRouterSpendGuard | null,
): import('./core.js').Model[] {
	const byKey = new Map(offers.map((offer) => [`${offer.provider}:${offer.modelId}`, offer]));
	return models.map((model) => {
		if (model.provider !== 'openrouter') return model;
		const offer = byKey.get(`${model.provider}:${model.id}`);
		if (!offer) return model;
		return {
			...model,
			trialCreditBudgetUsd: offer.trialCreditBudgetUsd,
			trialExpiresAt: offer.trialExpiresAt,
			trialCreditEvidence: offer.trialCreditEvidence,
			termsEvidence: offer.termsEvidence,
			spendGuardEvidence: guard,
			usageTerms: `Owner-verified trial credits through ${offer.trialExpiresAt}; OpenRouter key spending is limited to its finite non-resetting cap.`,
		};
	});
}
export const defaultConfig = ReviewConfigSchema.parse({});
export async function loadTrustedConfig(api: Octokit, owner: string, repo: string, ref: string): Promise<ReviewConfig> {
	try {
		const result = await api.repos.getContent({ owner, repo, path: 'review-app.yml', ref });
		if (Array.isArray(result.data) || result.data.type !== 'file' || result.data.encoding !== 'base64')
			throw new Error('review-app.yml must be a regular text file');
		const source = Buffer.from(result.data.content, 'base64').toString('utf8');
		return parseReviewConfig(source);
	} catch (e) {
		if ((e as { status?: number }).status === 404) return defaultConfig;
		throw e;
	}
}
