import {
	ModelSchema,
	OpenRouterSpendGuardSchema,
	Providers,
	type Model,
	type OpenRouterSpendGuard,
	type Provider,
} from './core.js';
import { z } from 'zod';

type Catalog = { url: string; key?: string; listPath: string };
const catalogs: Record<Exclude<Provider, 'github-models'>, Catalog> = {
	openrouter: { url: 'https://openrouter.ai/api/v1/models', listPath: 'data' },
	nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', key: 'NVIDIA_API_KEY', listPath: 'data' },
	groq: { url: 'https://api.groq.com/openai/v1/models', key: 'GROQ_API_KEY', listPath: 'data' },
	gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models', key: 'GEMINI_API_KEY', listPath: 'models' },
	cerebras: { url: 'https://api.cerebras.ai/v1/models', key: 'CEREBRAS_API_KEY', listPath: 'data' },
	mistral: { url: 'https://api.mistral.ai/v1/models', key: 'MISTRAL_API_KEY', listPath: 'data' },
	cloudflare: {
		url: process.env.CLOUDFLARE_ACCOUNT_ID
			? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?format=openrouter`
			: '',
		key: 'CLOUDFLARE_API_TOKEN',
		listPath: 'result',
	},
};
const now = () => new Date().toISOString();
const OpenRouterKeyResponseSchema = z
	.object({
		data: z
			.object({
				limit: z.number().positive().nullable(),
				limit_remaining: z.number().nonnegative().nullable(),
				limit_reset: z.enum(['daily', 'weekly', 'monthly']).nullable(),
				include_byok_in_limit: z.boolean(),
				is_free_tier: z.boolean(),
				expires_at: z.string().datetime().nullable().optional(),
			})
			.passthrough(),
	})
	.passthrough();
function atPath(value: unknown, path: string): unknown {
	return path
		.split('.')
		.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value);
}
function num(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

export class CatalogAdapter {
	constructor(readonly provider: Provider) {}
	async discover(fetcher: typeof fetch = fetch): Promise<Model[]> {
		if (this.provider === 'github-models')
			throw new Error('GitHub Models was retired on 2026-07-30; catalog and inference are unavailable');
		const cfg = catalogs[this.provider],
			key = cfg.key ? process.env[cfg.key] : undefined;
		if (this.provider === 'cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID)
			throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
		const url =
			this.provider === 'cloudflare'
				? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?format=openrouter`
				: cfg.url;
		if (cfg.key && !key) return [];
		const headers: Record<string, string> = { accept: 'application/json' };
		if (key) headers.authorization = `Bearer ${key}`;
		if (this.provider === 'gemini' && key) {
			headers['x-goog-api-key'] = key;
			delete headers.authorization;
		}
		const res = await fetcher(url, { headers, signal: AbortSignal.timeout(12000) });
		if (!res.ok) throw new Error(`${this.provider} catalog HTTP ${res.status}`);
		const body: unknown = await res.json(),
			rows = atPath(body, cfg.listPath);
		if (!Array.isArray(rows)) throw new Error(`${this.provider} catalog response has no model list`);
		const observedAt = now();
		return rows.flatMap((row: unknown): Model[] => {
			if (!row || typeof row !== 'object') return [];
			const r = row as Record<string, unknown>,
				id = String(r.id ?? (typeof r.name === 'string' ? r.name.replace(/^models\//, '') : '')).trim();
			if (!id) return [];
			// Only OpenRouter's documented per-token fields and Cloudflare's OpenRouter
			// format are normalized. Other catalogs do not publish enough price detail.
			const p = (r.pricing && typeof r.pricing === 'object' ? r.pricing : {}) as Record<string, unknown>;
			const inputRaw = num(p.prompt ?? p.input),
				outputRaw = num(p.completion ?? p.output);
			const hasOpenRouterPricing = this.provider === 'openrouter' || this.provider === 'cloudflare';
			const input = hasOpenRouterPricing && inputRaw !== null ? inputRaw * 1_000_000 : null;
			const output = hasOpenRouterPricing && outputRaw !== null ? outputRaw * 1_000_000 : null;
			const context = num(r.context_length ?? r.context_window ?? r.contextWindow ?? r.inputTokenLimit);
			const supportedMethods = Array.isArray(r.supportedGenerationMethods)
				? r.supportedGenerationMethods.filter((x): x is string => typeof x === 'string')
				: [];
			const mistralCapabilities = Array.isArray(r.capabilities)
				? r.capabilities.filter((x): x is string => typeof x === 'string')
				: [];
			const chatCapability =
				this.provider === 'gemini'
					? supportedMethods.includes('generateContent')
					: this.provider === 'mistral'
						? mistralCapabilities.includes('completion_chat')
						: this.provider === 'groq'
							? r.active === true &&
								Number.isSafeInteger(context) &&
								context! > 0 &&
								!/(whisper|transcrib|speech|text-to-speech)/i.test(id)
							: (this.provider === 'openrouter' || this.provider === 'cloudflare') &&
								  (r.type === 'chat' || Array.isArray(r.supported_parameters))
								? true
								: this.provider === 'cerebras'
									? true
									: null;
			const trialExpiry = typeof r.trial_expires_at === 'string' ? r.trial_expires_at : null;
			const nvidiaTerms =
				this.provider === 'nvidia'
					? 'NVIDIA API Catalog access is evaluation-only unless production rights are separately verified.'
					: `Usage restrictions and account-specific eligibility are not established by this model catalog.`;
			const pricingSource = url;
			const freeOpenRouter = this.provider === 'openrouter' && id.endsWith(':free');
			const freeCloudflare = this.provider === 'cloudflare' && input === 0 && output === 0;
			const candidate = {
				provider: this.provider,
				id,
				inputUsdPerMillion: input,
				outputUsdPerMillion: output,
				priceEvidence: {
					input:
						input === null
							? null
							: {
									sourceUrl: pricingSource,
									observedAt,
									claim: `Catalog reports input price ${inputRaw} USD per token; normalized to USD per million tokens.`,
									usdPerMillion: input,
								},
					output:
						output === null
							? null
							: {
									sourceUrl: pricingSource,
									observedAt,
									claim: `Catalog reports output price ${outputRaw} USD per token; normalized to USD per million tokens.`,
									usdPerMillion: output,
								},
					currency: 'USD',
					unit: 'per-million-tokens',
				},
				// A listed zero price is not enough to infer that account exhaustion cannot
				// route to paid usage. Keep unknown unless the model has an explicit free id.
				quotaEvidence: freeOpenRouter
					? {
							sourceUrl: 'https://openrouter.ai/docs/guides/routing/provider-selection',
							observedAt,
							description:
								'Inference requests disable provider fallbacks and enforce a zero input/output max_price ceiling; requests fail closed if no qualifying free route is available.',
							noChargeAfterLimit: true,
						}
					: freeCloudflare
						? {
								sourceUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
								observedAt,
								description:
									'Workers AI includes a daily free allocation; paid usage may apply beyond the included allocation.',
								noChargeAfterLimit: false,
							}
						: null,
				capabilities: { chat: chatCapability, codeReview: null },
				...(Number.isSafeInteger(context) && context! > 0 ? { context } : {}),
				trialExpiresAt: trialExpiry,
				usageTerms: nvidiaTerms,
				termsEvidence:
					this.provider === 'nvidia'
						? {
								sourceUrl:
									'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf',
								observedAt,
								claim:
									'API trial use is limited to internal testing and evaluation unless separately licensed for production.',
							}
						: null,
				observedAt,
				sourceUrl: url,
			};
			const parsed = ModelSchema.safeParse(candidate);
			return parsed.success ? [parsed.data] : [];
		});
	}
}
/** Read the current inference key's enforced spend cap; never create or modify provider keys. */
export async function getOpenRouterSpendGuard(fetcher: typeof fetch = fetch): Promise<OpenRouterSpendGuard | null> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) return null;
	const response = await fetcher('https://openrouter.ai/api/v1/key', {
		headers: { accept: 'application/json', authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(12000),
	});
	if (!response.ok) throw new Error(`OpenRouter key guard HTTP ${response.status}`);
	const parsed = OpenRouterKeyResponseSchema.safeParse(await response.json());
	if (!parsed.success) throw new Error('OpenRouter key guard response is malformed');
	return OpenRouterSpendGuardSchema.parse({
		sourceUrl: 'https://openrouter.ai/api/v1/key',
		observedAt: now(),
		isFreeTier: parsed.data.data.is_free_tier,
		limitUsd: parsed.data.data.limit,
		remainingUsd: parsed.data.data.limit_remaining,
		limitReset: parsed.data.data.limit_reset,
		includeByokInLimit: parsed.data.data.include_byok_in_limit,
		expiresAt: parsed.data.data.expires_at ?? null,
	});
}
export type DiscoveryResult = {
	models: Model[];
	status: 'available' | 'unauthenticated' | 'retired' | 'error';
	error?: string;
};
export async function discoverAll(): Promise<Record<Provider, DiscoveryResult>> {
	const pairs = await Promise.all(
		Providers.map(async (p) => {
			if (p === 'github-models')
				return [p, { models: [], status: 'retired', error: 'GitHub Models was retired on 2026-07-30' }] as const;
			if (p === 'cloudflare' && (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN))
				return [p, { models: [], status: 'unauthenticated' }] as const;
			if (p !== 'openrouter' && p !== 'cloudflare' && !process.env[catalogs[p].key!])
				return [p, { models: [], status: 'unauthenticated' }] as const;
			try {
				return [p, { models: await new CatalogAdapter(p).discover(), status: 'available' }] as const;
			} catch (e) {
				return [p, { models: [], status: 'error', error: e instanceof Error ? e.message : 'catalog failure' }] as const;
			}
		}),
	);
	return Object.fromEntries(pairs) as Record<Provider, DiscoveryResult>;
}
