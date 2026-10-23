import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectEngineBoundaryViolations } from './check-engine-boundaries.mjs';

test('recursively rejects host imports, ambient environment access, and host globals', async () => {
	const root = await mkdtemp(join(tmpdir(), 'reviewer-engine-boundaries-'));
	try {
		const nested = join(root, 'nested');
		await mkdir(nested);
		await writeFile(join(root, 'index.ts'), `export { readFile } from 'node:fs/promises';\n`);
		await writeFile(
			join(nested, 'provider.ts'),
			`const token = globalThis['process']['env'].API_KEY;\n` +
				`const platformToken = import.meta.env.API_KEY;\n` +
				`const fileSystem = await import('fs/promises');\n` +
				`fetch('https://example.test');\n` +
				`setTimeout(() => undefined, 10);\n` +
				`// Comments do not count: process.env and fetch()\n`,
		);

		const violations = await collectEngineBoundaryViolations(root);
		assert.equal(violations.length, 7);
		assert.ok(violations.some((violation) => violation.includes('node:fs/promises')));
		assert.ok(violations.some((violation) => violation.includes('fs/promises')));
		assert.ok(violations.some((violation) => violation.includes('globalThis.process.env')));
		assert.ok(violations.some((violation) => violation.includes('import.meta.env')));
		assert.ok(violations.some((violation) => violation.includes('host runtime global "fetch"')));
		assert.ok(violations.some((violation) => violation.includes('host runtime global "globalThis"')));
		assert.ok(violations.some((violation) => violation.includes('host runtime global "setTimeout"')));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('allows package dependencies, relative engine modules, and injected runtime ports', async () => {
	const root = await mkdtemp(join(tmpdir(), 'reviewer-engine-boundaries-'));
	try {
		await writeFile(join(root, 'index.ts'), `import { z } from 'zod';\nimport { inference } from './ports.js';\n`);
		await writeFile(
			join(root, 'ports.ts'),
			`export interface InferencePort { complete(prompt: string): Promise<string> }\n`,
		);
		assert.deepEqual(await collectEngineBoundaryViolations(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects imports that escape the engine package source root', async () => {
	const root = await mkdtemp(join(tmpdir(), 'reviewer-engine-boundaries-'));
	try {
		await writeFile(join(root, 'index.ts'), `export { load } from '../../src/adapter.js';\n`);
		const violations = await collectEngineBoundaryViolations(root);
		assert.equal(violations.length, 1);
		assert.ok(violations[0]?.includes('imports host runtime module'));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
