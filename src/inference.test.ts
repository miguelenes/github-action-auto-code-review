import test from 'node:test';
import assert from 'node:assert/strict';
import { completeModel } from './inference.js';
import type { Provider } from './core.js';

const envKeys = [
	'OPENROUTER_API_KEY',
	'NVIDIA_API_KEY',
	'GROQ_API_KEY',
	'GEMINI_API_KEY',
	'CEREBRAS_API_KEY',
	'MISTRAL_API_KEY',
	'CLOUDFLARE_API_TOKEN',
	'CLOUDFLARE_ACCOUNT_ID',
] as const;
async function withCredentials(run: () => Promise<void>): Promise<void> {
	const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	for (const key of envKeys) process.env[key] = key === 'CLOUDFLARE_ACCOUNT_ID' ? 'test-account' : 'fixture-secret';
	try {
		await run();
	} finally {
		for (const key of envKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test('OpenAI-compatible provider adapters send each model to its own provider endpoint', async () =>
	withCredentials(async () => {
		const endpoints: Partial<Record<Provider, string>> = {
			openrouter: 'https://openrouter.ai/api/v1/chat/completions',
			nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
			groq: 'https://api.groq.com/openai/v1/chat/completions',
			cerebras: 'https://api.cerebras.ai/v1/chat/completions',
			mistral: 'https://api.mistral.ai/v1/chat/completions',
			cloudflare: 'https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions',
		};
		for (const [provider, url] of Object.entries(endpoints)) {
			let called = 0;
			const text = await completeModel(
				{ provider: provider as Provider, id: 'fixture-model' },
				'system role',
				'untrusted prompt',
				async (input, init) => {
					called++;
					assert.equal(input, url);
					assert.equal(init?.method, 'POST');
					assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret');
					const body = JSON.parse(String(init?.body)) as {
						model: string;
						temperature: number;
						messages: { role: string; content: string }[];
						provider?: { allow_fallbacks: boolean; max_price: { prompt: number; completion: number } };
					};
					assert.equal(body.model, 'fixture-model');
					assert.equal(body.temperature, 0);
					assert.equal(body.messages[1]?.content, 'untrusted prompt');
					if (provider === 'openrouter')
						assert.deepEqual(body.provider, { allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } });
					return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
				},
			);
			assert.equal(text, '{"ok":true}');
			assert.equal(called, 1);
		}
	}));

test('Gemini uses its native generateContent request and header authentication', async () =>
	withCredentials(async () => {
		let called = 0;
		const text = await completeModel(
			{ provider: 'gemini', id: 'gemini-test' },
			'system prompt',
			'review input',
			async (input, init) => {
				called++;
				assert.equal(input, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
				const headers = new Headers(init?.headers);
				assert.equal(headers.get('x-goog-api-key'), 'fixture-secret');
				assert.equal(headers.get('authorization'), null);
				const body = JSON.parse(String(init?.body)) as {
					systemInstruction: { parts: { text: string }[] };
					contents: { parts: { text: string }[] }[];
					generationConfig: { responseMimeType: string };
				};
				assert.equal(body.systemInstruction.parts[0]?.text, 'system prompt');
				assert.equal(body.contents[0]?.parts[0]?.text, 'review input');
				assert.equal(body.generationConfig.responseMimeType, 'application/json');
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), {
					status: 200,
				});
			},
		);
		assert.equal(text, '{"ok":true}');
		assert.equal(called, 1);
	}));

test('provider throttling does not silently retry against another provider', async () =>
	withCredentials(async () => {
		let called = 0;
		await assert.rejects(
			completeModel({ provider: 'groq', id: 'model' }, 'system', 'prompt', async () => {
				called++;
				return new Response('', { status: 429 });
			}),
			/groq inference HTTP 429/,
		);
		assert.equal(called, 1);
	}));

test('OpenRouter trial inference refreshes the provider cap and uses exact catalog ceilings with fallback disabled', async () =>
	withCredentials(async () => {
		const now = new Date().toISOString();
		let calls = 0;
		const model = {
			provider: 'openrouter' as const,
			id: 'trial-model',
			inputUsdPerMillion: 0.25,
			outputUsdPerMillion: 0.5,
			priceEvidence: {
				input: {
					sourceUrl: 'https://openrouter.ai/api/v1/models',
					observedAt: now,
					claim: 'catalog',
					usdPerMillion: 0.25,
				},
				output: {
					sourceUrl: 'https://openrouter.ai/api/v1/models',
					observedAt: now,
					claim: 'catalog',
					usdPerMillion: 0.5,
				},
				currency: 'USD' as const,
				unit: 'per-million-tokens' as const,
			},
			trialCreditBudgetUsd: 10,
			trialExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			trialCreditEvidence: { sourceUrl: 'https://owner.example/trial', observedAt: now, claim: 'verified' },
			termsEvidence: { sourceUrl: 'https://openrouter.ai/terms', observedAt: now, claim: 'verified' },
			spendGuardEvidence: null,
		};
		const result = await completeModel(model, 'system', 'prompt', async (input, init) => {
			calls++;
			if (calls === 1) {
				assert.equal(input, 'https://openrouter.ai/api/v1/key');
				assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret');
				return new Response(
					JSON.stringify({
						data: {
							is_free_tier: true,
							limit: 8,
							limit_remaining: 7.5,
							limit_reset: null,
							include_byok_in_limit: true,
							expires_at: model.trialExpiresAt,
						},
					}),
				);
			}
			assert.equal(input, 'https://openrouter.ai/api/v1/chat/completions');
			const body = JSON.parse(String(init?.body)) as {
				provider: { allow_fallbacks: boolean; max_price: { prompt: number; completion: number } };
			};
			assert.deepEqual(body.provider, { allow_fallbacks: false, max_price: { prompt: 0.25, completion: 0.5 } });
			return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
		});
		assert.equal(result, 'ok');
		assert.equal(calls, 2);
	}));

test('OpenRouter trial inference fails closed before completion when its live cap is unsafe', async () =>
	withCredentials(async () => {
		const now = new Date().toISOString();
		let calls = 0;
		const model = {
			provider: 'openrouter' as const,
			id: 'trial-model',
			inputUsdPerMillion: 0.25,
			outputUsdPerMillion: 0.5,
			priceEvidence: {
				input: {
					sourceUrl: 'https://openrouter.ai/api/v1/models',
					observedAt: now,
					claim: 'catalog',
					usdPerMillion: 0.25,
				},
				output: {
					sourceUrl: 'https://openrouter.ai/api/v1/models',
					observedAt: now,
					claim: 'catalog',
					usdPerMillion: 0.5,
				},
				currency: 'USD' as const,
				unit: 'per-million-tokens' as const,
			},
			trialCreditBudgetUsd: 10,
			trialExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			trialCreditEvidence: { sourceUrl: 'https://owner.example/trial', observedAt: now, claim: 'verified' },
			termsEvidence: { sourceUrl: 'https://openrouter.ai/terms', observedAt: now, claim: 'verified' },
			spendGuardEvidence: null,
		};
		await assert.rejects(
			completeModel(model, 'system', 'prompt', async () => {
				calls++;
				return new Response(
					JSON.stringify({
						data: {
							is_free_tier: true,
							limit: 11,
							limit_remaining: 10,
							limit_reset: null,
							include_byok_in_limit: true,
							expires_at: model.trialExpiresAt,
						},
					}),
				);
			}),
			/trial spend guard/,
		);
		assert.equal(calls, 1);
	}));

test('missing credentials and retired GitHub Models fail before sending a request', async () => {
	const previous = process.env.GROQ_API_KEY;
	delete process.env.GROQ_API_KEY;
	try {
		let called = 0;
		await assert.rejects(
			completeModel({ provider: 'groq', id: 'model' }, 's', 'p', async () => {
				called++;
				return new Response('{}');
			}),
			/GROQ_API_KEY is required/,
		);
		assert.equal(called, 0);
		await assert.rejects(
			completeModel({ provider: 'github-models', id: 'model' }, 's', 'p', async () => {
				called++;
				return new Response('{}');
			}),
			/retired/,
		);
		assert.equal(called, 0);
	} finally {
		if (previous === undefined) delete process.env.GROQ_API_KEY;
		else process.env.GROQ_API_KEY = previous;
	}
});
