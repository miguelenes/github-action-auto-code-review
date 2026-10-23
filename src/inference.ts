import { z } from 'zod';
import { trialSpendCapAllows, type Model, type Provider } from './core.js';
import { getOpenRouterSpendGuard } from './providers.js';

const compatibleEndpoints: Partial<Record<Provider, { url: (modelId: string) => string; key: string }>> = {
	openrouter: { url: () => 'https://openrouter.ai/api/v1/chat/completions', key: 'OPENROUTER_API_KEY' },
	nvidia: { url: () => 'https://integrate.api.nvidia.com/v1/chat/completions', key: 'NVIDIA_API_KEY' },
	groq: { url: () => 'https://api.groq.com/openai/v1/chat/completions', key: 'GROQ_API_KEY' },
	cerebras: { url: () => 'https://api.cerebras.ai/v1/chat/completions', key: 'CEREBRAS_API_KEY' },
	mistral: { url: () => 'https://api.mistral.ai/v1/chat/completions', key: 'MISTRAL_API_KEY' },
	cloudflare: {
		url: () => {
			const account = process.env.CLOUDFLARE_ACCOUNT_ID;
			if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is required for Workers AI inference');
			return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/chat/completions`;
		},
		key: 'CLOUDFLARE_API_TOKEN',
	},
};

const OpenAIResponseSchema = z
	.object({
		choices: z
			.array(
				z
					.object({
						message: z
							.object({
								content: z
									.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())])
									.nullable()
									.optional(),
							})
							.passthrough()
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();
const GeminiResponseSchema = z
	.object({
		candidates: z
			.array(
				z
					.object({
						content: z
							.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional() })
							.passthrough()
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

function tokenFor(provider: Provider): string {
	const name =
		provider === 'gemini'
			? 'GEMINI_API_KEY'
			: provider === 'github-models'
				? 'GITHUB_TOKEN'
				: compatibleEndpoints[provider]?.key;
	if (!name) throw new Error(`${provider} inference is unavailable`);
	const token = process.env[name];
	if (!token) throw new Error(`${name} is required for ${provider} inference`);
	return token;
}

/** Run one provider call only. Failures never switch providers or retry on a paid route. */
type InferenceModel = Pick<Model, 'provider' | 'id'> &
	Partial<
		Pick<
			Model,
			| 'inputUsdPerMillion'
			| 'outputUsdPerMillion'
			| 'priceEvidence'
			| 'trialCreditBudgetUsd'
			| 'trialExpiresAt'
			| 'trialCreditEvidence'
			| 'termsEvidence'
			| 'spendGuardEvidence'
		>
	>;
export async function completeModel(
	model: InferenceModel,
	system: string,
	prompt: string,
	fetcher: typeof fetch = fetch,
	credential?: string,
): Promise<string> {
	const { provider } = model;
	if (provider === 'github-models')
		throw new Error('GitHub Models was retired on 2026-07-30; inference is unavailable');
	const token = credential ?? tokenFor(provider);
	const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
	let url: string, body: unknown;
	if (provider === 'gemini') {
		url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:generateContent`;
		headers['x-goog-api-key'] = token;
		body = {
			systemInstruction: { parts: [{ text: system }] },
			contents: [{ role: 'user', parts: [{ text: prompt }] }],
			generationConfig: { temperature: 0, responseMimeType: 'application/json' },
		};
	} else {
		const endpoint = compatibleEndpoints[provider];
		if (!endpoint) throw new Error(`${provider} inference is unavailable`);
		url = endpoint.url(model.id);
		headers.authorization = `Bearer ${token}`;
		let openRouterProvider: unknown;
		if (provider === 'openrouter') {
			let promptCeiling = 0,
				completionCeiling = 0;
			if ((model.inputUsdPerMillion ?? 0) > 0 || (model.outputUsdPerMillion ?? 0) > 0) {
				const guard = await getOpenRouterSpendGuard(fetcher);
				if (!trialSpendCapAllows(model as Model, guard, new Date()))
					throw new Error('OpenRouter trial spend guard is missing, stale, or no longer within its verified cap');
				promptCeiling = model.inputUsdPerMillion!;
				completionCeiling = model.outputUsdPerMillion!;
			}
			openRouterProvider = {
				allow_fallbacks: false,
				max_price: { prompt: promptCeiling, completion: completionCeiling },
			};
		}
		body = {
			model: model.id,
			temperature: 0,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: prompt },
			],
			...(provider === 'openrouter' ? { provider: openRouterProvider } : {}),
		};
	}
	const response = await fetcher(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(45000),
	});
	if (!response.ok) throw new Error(`${provider} inference HTTP ${response.status}`);
	const raw: unknown = await response.json();
	if (provider === 'gemini') {
		const parsed = GeminiResponseSchema.safeParse(raw);
		const text = parsed.success
			? parsed.data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
			: undefined;
		if (!text) throw new Error(`${provider} returned no text candidate`);
		return text;
	}
	const parsed = OpenAIResponseSchema.safeParse(raw);
	const content = parsed.success ? parsed.data.choices?.[0]?.message?.content : undefined;
	const text =
		typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : '';
	if (!text) throw new Error(`${provider} returned no text choice`);
	return text;
}
