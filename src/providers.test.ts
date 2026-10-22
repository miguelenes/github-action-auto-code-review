import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, Providers, type Provider } from './core.js';
import { CatalogAdapter, getOpenRouterSpendGuard } from './providers.js';

test('OpenRouter per-token prices normalize and free variant carries bounded quota evidence', async () => {
	const adapter = new CatalogAdapter('openrouter');
	const models = await adapter.discover(
		async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: 'example:free', context_length: 4096, pricing: { prompt: '0', completion: '0' } },
						{ id: 'paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
					],
				}),
				{ status: 200 },
			),
	);
	assert.equal(models.length, 2);
	assert.equal(models[0]?.inputUsdPerMillion, 0);
	assert.equal(models[1]?.inputUsdPerMillion, 1);
	assert.equal(models[0]?.quotaEvidence?.noChargeAfterLimit, true);
});
test('all eight planned providers have an explicit discovery path', () =>
	assert.deepEqual(
		[...Providers],
		['openrouter', 'nvidia', 'groq', 'gemini', 'cerebras', 'mistral', 'github-models', 'cloudflare'],
	));
test('GitHub Models retirement is returned as a terminal provider condition', async () => {
	await assert.rejects(
		new CatalogAdapter('github-models').discover(async () => new Response('{}')),
		/retired on 2026-07-30/,
	);
});
test('catalog failures preserve throttling, malformed response, and outage signals', async () => {
	const adapter = new CatalogAdapter('openrouter');
	await assert.rejects(
		adapter.discover(async () => new Response('', { status: 429 })),
		/HTTP 429/,
	);
	await assert.rejects(
		adapter.discover(async () => new Response(JSON.stringify({ unexpected: [] }))),
		/no model list/,
	);
	await assert.rejects(
		adapter.discover(async () => {
			throw new Error('offline');
		}),
		/offline/,
	);
});
test('missing price is unknown, and generic provider price fields are not guessed', async () => {
	const adapter = new CatalogAdapter('openrouter');
	const [m] = await adapter.discover(
		async () => new Response(JSON.stringify({ data: [{ id: 'unknown' }] }), { status: 200 }),
	);
	assert.equal(m?.inputUsdPerMillion, null);
	assert.equal(m?.priceEvidence.input, null);
	const old = process.env.GROQ_API_KEY;
	process.env.GROQ_API_KEY = 'fixture-token';
	try {
		const [groq] = await new CatalogAdapter('groq').discover(
			async () =>
				new Response(JSON.stringify({ data: [{ id: 'free-model', input_price: 0, output_price: 0 }] }), {
					status: 200,
				}),
		);
		assert.equal(groq?.inputUsdPerMillion, null);
		assert.equal(groq?.quotaEvidence, null);
	} finally {
		if (old === undefined) delete process.env.GROQ_API_KEY;
		else process.env.GROQ_API_KEY = old;
	}
});
test('provider list contract parses official model array shapes without inventing prices', async () => {
	const cases = [
		['nvidia', 'NVIDIA_API_KEY', { data: [{ id: 'meta/llama' }] }],
		['groq', 'GROQ_API_KEY', { data: [{ id: 'llama' }] }],
		['gemini', 'GEMINI_API_KEY', { models: [{ name: 'models/gemini-2.0-flash', inputTokenLimit: 1000 }] }],
		['cerebras', 'CEREBRAS_API_KEY', { data: [{ id: 'llama' }] }],
		['mistral', 'MISTRAL_API_KEY', { data: [{ id: 'codestral' }] }],
	];
	for (const [provider, env, fixture] of cases as [Provider, string, unknown][]) {
		const old = process.env[env];
		process.env[env] = 'fixture-token';
		try {
			const [model] = await new CatalogAdapter(provider).discover(
				async () => new Response(JSON.stringify(fixture), { status: 200 }),
			);
			assert.ok(model, `${provider} fixture should parse`);
			assert.equal(model.inputUsdPerMillion, null);
			assert.equal(model.priceEvidence.input, null);
		} finally {
			if (old === undefined) delete process.env[env];
			else process.env[env] = old;
		}
	}
});
test('Groq active chat catalog records context but leaves eligibility evidence to trusted policy', async () => {
	const old = process.env.GROQ_API_KEY;
	process.env.GROQ_API_KEY = 'fixture-token';
	try {
		const models = await new CatalogAdapter('groq').discover(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: 'llama-3.1-8b-instant', active: true, context_window: 131072 },
							{ id: 'whisper-large-v3', active: true, context_window: 448 },
						],
					}),
					{ status: 200 },
				),
		);
		assert.equal(models[0]?.context, 131072);
		assert.equal(models[0]?.capabilities.chat, true);
		assert.equal(models[0]?.inputUsdPerMillion, null);
		assert.equal(models[0]?.quotaEvidence, null);
		assert.equal(models[1]?.capabilities.chat, false);
	} finally {
		if (old === undefined) delete process.env.GROQ_API_KEY;
		else process.env.GROQ_API_KEY = old;
	}
});
test('Cloudflare OpenRouter-format zero prices remain ineligible above free allocation', async () => {
	const oldId = process.env.CLOUDFLARE_ACCOUNT_ID,
		oldKey = process.env.CLOUDFLARE_API_TOKEN;
	process.env.CLOUDFLARE_ACCOUNT_ID = 'fixture';
	process.env.CLOUDFLARE_API_TOKEN = 'fixture-token';
	try {
		const [model] = await new CatalogAdapter('cloudflare').discover(
			async () =>
				new Response(JSON.stringify({ result: [{ id: '@cf/model', pricing: { prompt: '0', completion: '0' } }] }), {
					status: 200,
				}),
		);
		assert.equal(model?.inputUsdPerMillion, 0);
		assert.equal(model?.quotaEvidence?.noChargeAfterLimit, false);
	} finally {
		if (oldId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
		else process.env.CLOUDFLARE_ACCOUNT_ID = oldId;
		if (oldKey === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
		else process.env.CLOUDFLARE_API_TOKEN = oldKey;
	}
});
test('all active provider fixtures preserve their documented catalog shapes and unknown pricing', async () => {
	const fixtures: [Provider, unknown][] = [
		[
			'openrouter',
			{
				data: [
					{
						id: 'example:free',
						context_length: 8192,
						pricing: { prompt: '0', completion: '0' },
						supported_parameters: ['tools'],
					},
				],
			},
		],
		['nvidia', { data: [{ id: 'meta/llama-3.1', context_length: 131072 }] }],
		['groq', { data: [{ id: 'llama-3.1-8b', active: true, context_window: 131072 }] }],
		[
			'gemini',
			{
				models: [
					{ name: 'models/gemini-2.5-flash', inputTokenLimit: 100000, supportedGenerationMethods: ['generateContent'] },
				],
			},
		],
		['cerebras', { data: [{ id: 'llama-3.3-70b', context_length: 65536 }] }],
		['mistral', { data: [{ id: 'codestral', context_length: 32000, capabilities: ['completion_chat'] }] }],
		[
			'cloudflare',
			{
				result: [
					{ id: '@cf/meta/llama', context_length: 8192, pricing: { prompt: '0', completion: '0' }, type: 'chat' },
				],
			},
		],
	];
	const envNames = [
		'NVIDIA_API_KEY',
		'GROQ_API_KEY',
		'GEMINI_API_KEY',
		'CEREBRAS_API_KEY',
		'MISTRAL_API_KEY',
		'CLOUDFLARE_API_TOKEN',
		'CLOUDFLARE_ACCOUNT_ID',
	];
	const previous = new Map(envNames.map((name) => [name, process.env[name]]));
	for (const name of envNames) process.env[name] = 'fixture-token';
	process.env.CLOUDFLARE_ACCOUNT_ID = 'fixture-account';
	try {
		for (const [provider, fixture] of fixtures) {
			const adapter = new CatalogAdapter(provider);
			const [model] = await adapter.discover(async () => new Response(JSON.stringify(fixture), { status: 200 }));
			assert.ok(model, `${provider} fixture should parse`);
			assert.equal(
				model.inputUsdPerMillion,
				provider === 'openrouter' || provider === 'cloudflare' ? 0 : null,
				`${provider} unknown price must stay unknown`,
			);
			if (provider === 'cloudflare') assert.equal(model.quotaEvidence?.noChargeAfterLimit, false);
			if (provider === 'openrouter') assert.equal(model.quotaEvidence?.noChargeAfterLimit, true);
		}
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
test('malformed catalogs, throttling, and outages fail closed for every active provider', async () => {
	const providers: Provider[] = ['openrouter', 'nvidia', 'groq', 'gemini', 'cerebras', 'mistral', 'cloudflare'];
	const envNames = [
		'NVIDIA_API_KEY',
		'GROQ_API_KEY',
		'GEMINI_API_KEY',
		'CEREBRAS_API_KEY',
		'MISTRAL_API_KEY',
		'CLOUDFLARE_API_TOKEN',
		'CLOUDFLARE_ACCOUNT_ID',
	];
	const previous = new Map(envNames.map((name) => [name, process.env[name]]));
	for (const name of envNames) process.env[name] = 'fixture-token';
	try {
		for (const provider of providers) {
			const adapter = new CatalogAdapter(provider);
			await assert.rejects(
				adapter.discover(async () => new Response(JSON.stringify({ unexpected: [] }))),
				/no model list/,
				`${provider} must reject malformed catalog`,
			);
			await assert.rejects(
				adapter.discover(async () => new Response('', { status: 429 })),
				/HTTP 429/,
				`${provider} must preserve throttling`,
			);
			await assert.rejects(
				adapter.discover(async () => {
					throw new Error('fixture outage');
				}),
				/fixture outage/,
				`${provider} must preserve outage`,
			);
		}
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
test('expired provider trial metadata is retained as a block rather than treated as free access', async () => {
	const adapter = new CatalogAdapter('openrouter');
	const [model] = await adapter.discover(
		async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: 'example:free',
							pricing: { prompt: '0', completion: '0' },
							trial_expires_at: '2020-01-01T00:00:00.000Z',
						},
					],
				}),
				{ status: 200 },
			),
	);
	assert.equal(model?.trialExpiresAt, '2020-01-01T00:00:00.000Z');
	assert.equal(eligible(model!), false);
});

test('OpenRouter key spend guard parses live non-resetting cap, BYOK, tier, and expiry evidence', async () => {
	const old = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = 'fixture-token';
	try {
		const guard = await getOpenRouterSpendGuard(async (url, init) => {
			assert.equal(url, 'https://openrouter.ai/api/v1/key');
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
			return new Response(
				JSON.stringify({
					data: {
						is_free_tier: true,
						limit: 5,
						limit_remaining: 4.25,
						limit_reset: null,
						include_byok_in_limit: true,
						expires_at: '2030-01-01T00:00:00.000Z',
					},
				}),
			);
		});
		assert.equal(guard?.limitUsd, 5);
		assert.equal(guard?.remainingUsd, 4.25);
		assert.equal(guard?.limitReset, null);
		assert.equal(guard?.includeByokInLimit, true);
		assert.equal(guard?.expiresAt, '2030-01-01T00:00:00.000Z');
	} finally {
		if (old === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = old;
	}
});

test('OpenRouter key spend guard rejects provider errors and malformed safety fields', async () => {
	const old = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = 'fixture-token';
	try {
		await assert.rejects(
			getOpenRouterSpendGuard(async () => new Response('', { status: 401 })),
			/guard HTTP 401/,
		);
		await assert.rejects(
			getOpenRouterSpendGuard(async () => new Response(JSON.stringify({ data: { limit: 5 } }))),
			/malformed/,
		);
	} finally {
		if (old === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = old;
	}
});
