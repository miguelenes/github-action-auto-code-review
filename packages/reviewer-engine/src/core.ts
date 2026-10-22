import { z } from 'zod';
export const Providers = [
	'openrouter',
	'nvidia',
	'groq',
	'gemini',
	'cerebras',
	'mistral',
	'github-models',
	'cloudflare',
] as const;
export type Provider = (typeof Providers)[number];
export const EvidenceSchema = z.object({
	sourceUrl: z.string().url(),
	observedAt: z.string().datetime(),
	claim: z.string().min(1),
});
const PricePointEvidenceSchema = EvidenceSchema.extend({ usdPerMillion: z.number().nonnegative() });
export const PriceEvidenceSchema = z.object({
	input: PricePointEvidenceSchema.nullable(),
	output: PricePointEvidenceSchema.nullable(),
	currency: z.literal('USD'),
	unit: z.literal('per-million-tokens'),
});
export const QuotaEvidenceSchema = z
	.object({
		sourceUrl: z.string().url(),
		observedAt: z.string().datetime(),
		description: z.string().min(1),
		noChargeAfterLimit: z.boolean().nullable(),
	})
	.nullable();
export const OpenRouterSpendGuardSchema = z.object({
	sourceUrl: z.string().url(),
	observedAt: z.string().datetime(),
	isFreeTier: z.boolean(),
	limitUsd: z.number().positive().nullable(),
	remainingUsd: z.number().nonnegative().nullable(),
	limitReset: z.enum(['daily', 'weekly', 'monthly']).nullable(),
	includeByokInLimit: z.boolean(),
	expiresAt: z.string().datetime().nullable(),
});
export type OpenRouterSpendGuard = z.infer<typeof OpenRouterSpendGuardSchema>;
export const ModelSchema = z
	.object({
		provider: z.enum(Providers),
		id: z.string(),
		context: z.number().int().positive().optional(),
		inputUsdPerMillion: z.number().nonnegative().nullable(),
		outputUsdPerMillion: z.number().nonnegative().nullable(),
		priceEvidence: PriceEvidenceSchema,
		quotaEvidence: QuotaEvidenceSchema,
		accountTierEvidence: EvidenceSchema.nullable().optional(),
		capabilities: z.object({ chat: z.boolean().nullable(), codeReview: z.boolean().nullable() }),
		trialExpiresAt: z.string().datetime().nullable().optional(),
		trialCreditBudgetUsd: z.number().positive().nullable().optional(),
		trialCreditEvidence: EvidenceSchema.nullable().optional(),
		spendGuardEvidence: OpenRouterSpendGuardSchema.nullable().optional(),
		usageTerms: z.string(),
		termsEvidence: EvidenceSchema.nullable(),
		observedAt: z.string().datetime(),
		sourceUrl: z.string().url(),
	})
	.superRefine((m, ctx) => {
		if (m.inputUsdPerMillion !== (m.priceEvidence.input?.usdPerMillion ?? null))
			ctx.addIssue({
				code: 'custom',
				path: ['priceEvidence', 'input'],
				message: 'input price evidence must match normalized input price',
			});
		if (m.outputUsdPerMillion !== (m.priceEvidence.output?.usdPerMillion ?? null))
			ctx.addIssue({
				code: 'custom',
				path: ['priceEvidence', 'output'],
				message: 'output price evidence must match normalized output price',
			});
	});
export type Model = z.infer<typeof ModelSchema>;
export const FindingCategorySchema = z.enum([
	'correctness',
	'specification',
	'standards',
	'security',
	'performance',
	'maintainability',
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;
export type Finding = {
	id: string;
	severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
	category: FindingCategory;
	title: string;
	path: string;
	line: number;
	evidence: string;
	impact: string;
	remediation: string;
	status: 'open' | 'fixed' | 'disputed';
};
export type ReviewRound = {
	pr: number;
	headSha: string;
	round: number;
	phase: 'review' | 'challenge' | 'fix' | 'verify' | 'complete' | 'needs-human';
	coverage: 'complete' | 'incomplete';
	findings: Finding[];
	disputed?: number;
	models: { provider: Provider; id: string; reason: string }[];
};
export interface ProviderAdapter {
	provider: Provider;
	discover(): Promise<Model[]>;
	complete(model: string, prompt: string): Promise<string>;
}
export function trialSpendCapAllows(
	m: Model,
	guard: OpenRouterSpendGuard | null | undefined,
	now = new Date(),
): boolean {
	const fresh = (at: string) => now.getTime() - new Date(at).getTime() <= 86400000 && new Date(at) <= now;
	if (
		m.provider !== 'openrouter' ||
		!guard ||
		!m.trialCreditEvidence ||
		!m.termsEvidence ||
		!m.trialExpiresAt ||
		!m.trialCreditBudgetUsd
	)
		return false;
	if (
		m.inputUsdPerMillion === null ||
		m.outputUsdPerMillion === null ||
		!m.priceEvidence.input ||
		!m.priceEvidence.output
	)
		return false;
	if (
		!fresh(m.priceEvidence.input.observedAt) ||
		!fresh(m.priceEvidence.output.observedAt) ||
		!fresh(m.trialCreditEvidence.observedAt) ||
		!fresh(m.termsEvidence.observedAt) ||
		!fresh(guard.observedAt)
	)
		return false;
	if (
		new Date(m.trialExpiresAt) <= now ||
		!guard.isFreeTier ||
		guard.limitUsd === null ||
		guard.remainingUsd === null ||
		guard.limitReset !== null ||
		!guard.includeByokInLimit
	)
		return false;
	if (
		guard.expiresAt === null ||
		new Date(guard.expiresAt) <= now ||
		new Date(guard.expiresAt) > new Date(m.trialExpiresAt)
	)
		return false;
	return guard.limitUsd <= m.trialCreditBudgetUsd && guard.remainingUsd > 0 && guard.remainingUsd <= guard.limitUsd;
}
export function eligible(m: Model, now = new Date()): boolean {
	const fresh = (at: string) => now.getTime() - new Date(at).getTime() <= 86400000 && new Date(at) <= now;
	if (
		!m.priceEvidence.input ||
		!m.priceEvidence.output ||
		m.inputUsdPerMillion === null ||
		m.outputUsdPerMillion === null ||
		!fresh(m.priceEvidence.input.observedAt) ||
		!fresh(m.priceEvidence.output.observedAt)
	)
		return false;
	if (
		m.priceEvidence.input.usdPerMillion !== m.inputUsdPerMillion ||
		m.priceEvidence.output.usdPerMillion !== m.outputUsdPerMillion
	)
		return false;
	if (!m.priceEvidence.input.claim || !m.priceEvidence.output.claim) return false;
	if (m.trialExpiresAt && new Date(m.trialExpiresAt) <= now) return false;
	if (m.termsEvidence && !fresh(m.termsEvidence.observedAt)) return false;
	if (m.inputUsdPerMillion > 0 || m.outputUsdPerMillion > 0) return trialSpendCapAllows(m, m.spendGuardEvidence, now);
	if (!m.quotaEvidence || m.quotaEvidence.noChargeAfterLimit !== true || !fresh(m.quotaEvidence.observedAt))
		return false;
	if (
		m.provider !== 'openrouter' &&
		(!m.accountTierEvidence ||
			!fresh(m.accountTierEvidence.observedAt) ||
			!m.termsEvidence ||
			!fresh(m.termsEvidence.observedAt))
	)
		return false;
	return true;
}
export function nextRound(previous: ReviewRound | undefined, headSha: string): number {
	if (!previous) return 1;
	if (previous.round >= 5) throw new Error('five review rounds exhausted; needs-human');
	if (previous.headSha === headSha && previous.phase === 'complete') return previous.round;
	return previous.round + 1;
}
export function mergeReady(r: ReviewRound, checksPass: boolean): boolean {
	return (
		r.phase === 'complete' &&
		r.coverage === 'complete' &&
		checksPass &&
		(r.disputed ?? 0) === 0 &&
		r.findings.every((f) => f.status === 'fixed')
	);
}
export const providers = Providers;
