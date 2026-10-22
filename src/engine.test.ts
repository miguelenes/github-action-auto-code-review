import test from 'node:test';
import assert from 'node:assert/strict';
import { independentReview, parseFilePatches, parseFindings, type Model } from '@miguelenes/reviewer-engine';

const model = (id: string) => ({ provider: 'groq', id }) as Model;
const evidence = {
	severity: 'high',
	category: 'security',
	title: 'Missing authorization',
	path: 'src/route.ts',
	line: 8,
	evidence: 'The route accepts anonymous requests.',
	impact: 'Private data is exposed.',
	remediation: 'Require a signed-in user.',
};

test('runtime-neutral review stages use injected prompts and inference only', async () => {
	const calls: string[] = [];
	const result = await independentReview({
		diff: '+ vulnerable route',
		models: [model('reviewer'), model('security'), model('challenger')],
		rolePrompts: { reviewer: 'review prompt', challenger: 'challenge prompt' },
		complete: async (selected, system) => {
			calls.push(`${selected.id}:${system}`);
			return selected.id === 'challenger' ? JSON.stringify([evidence]) : JSON.stringify([evidence]);
		},
	});
	assert.equal(result.findings.length, 1);
	assert.equal(result.findings[0]?.status, 'open');
	assert.equal(result.disputed, 0);
	assert.deepEqual(
		calls.map((call) => call.split(':')[0]),
		['reviewer', 'security', 'challenger'],
	);
});

test('portable findings and patches reject unsafe repository paths and oversized content', () => {
	assert.throws(() => parseFindings(JSON.stringify([{ ...evidence, path: '../secret' }])), /unsafe finding path/);
	assert.throws(
		() => parseFilePatches(JSON.stringify([{ path: '../secret', content: 'x' }]), new Set(['src/route.ts'])),
		/unsafe or out-of-scope/,
	);
	assert.throws(
		() =>
			parseFilePatches(
				JSON.stringify([{ path: 'src/route.ts', content: 'x'.repeat(500_001) }]),
				new Set(['src/route.ts']),
			),
		/unsafe or out-of-scope/,
	);
});
