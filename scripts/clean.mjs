import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await Promise.all(
	['dist', 'packages/reviewer-engine/dist'].map((directory) =>
		rm(path.join(root, directory), { recursive: true, force: true }),
	),
);
