import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../packages/reviewer-engine/src/', import.meta.url);
const files = (await readdir(root)).filter((file) => file.endsWith('.ts'));
const violations = [];
const forbiddenImport = /(?:from\s*|import\s*\()['"](?:node:|\.\.\/\.\.\/src\/)/;
const forbiddenGlobal = /\bprocess\.env\b|\b(?:readFile|writeFile|fetch|setTimeout)\s*\(/;

for (const file of files) {
	const source = await readFile(new URL(file, root), 'utf8');
	if (forbiddenImport.test(source)) violations.push(`${file}: engine source imports a host runtime module`);
	if (forbiddenGlobal.test(source))
		violations.push(`${file}: engine source accesses a host global instead of an injected port`);
}

if (violations.length) {
	process.stderr.write(`${violations.join('\n')}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`Engine boundary check passed for ${files.length} source files.\n`);
}
