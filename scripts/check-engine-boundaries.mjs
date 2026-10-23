import { builtinModules } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const engineSource = fileURLToPath(new URL('../packages/reviewer-engine/src/', import.meta.url));
const nodeBuiltins = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, '')));
const forbiddenGlobals = new Set([
	'process',
	'Deno',
	'Bun',
	'globalThis',
	'self',
	'window',
	'fetch',
	'setTimeout',
	'clearTimeout',
	'setInterval',
	'clearInterval',
]);
const environmentAccessPaths = new Set([
	'process.env',
	'globalThis.process.env',
	'Deno.env',
	'globalThis.Deno.env',
	'Bun.env',
	'globalThis.Bun.env',
	'import.meta.env',
]);

async function sourceFiles(root) {
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.isFile() && /\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(entry.name)) files.push(path);
	}
	return files.sort();
}

function accessPath(node) {
	if (ts.isIdentifier(node)) return [node.text];
	if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta')
		return ['import', 'meta'];
	if (ts.isPropertyAccessExpression(node)) return [...accessPath(node.expression), node.name.text];
	if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression))
		return [...accessPath(node.expression), node.argumentExpression.text];
	return [];
}

function isHostModule(moduleName, sourceFile, root) {
	if (moduleName.startsWith('node:') || nodeBuiltins.has(moduleName)) return true;
	if (!moduleName.startsWith('.')) return false;
	const target = resolve(dirname(sourceFile), moduleName);
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === '..' ||
		pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
		isAbsolute(pathFromRoot)
	);
}

export async function collectEngineBoundaryViolations(root = engineSource) {
	const absoluteRoot = resolve(root);
	const violations = [];
	const add = (file, message) => violations.push(`${relative(absoluteRoot, file)}: ${message}`);

	for (const file of await sourceFiles(absoluteRoot)) {
		const source = await readFile(file, 'utf8');
		const scriptKind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);

		function visit(node) {
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
				if (ts.isStringLiteralLike(node.moduleSpecifier) && isHostModule(node.moduleSpecifier.text, file, absoluteRoot))
					add(file, `imports host runtime module "${node.moduleSpecifier.text}"`);
			}

			if (ts.isCallExpression(node)) {
				const calledPath = accessPath(node.expression).join('.');
				if (calledPath === 'Date.now' || (calledPath === 'Date' && node.arguments.length === 0))
					add(file, `reads ambient system time through "${calledPath}()"`);
				if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
					const [argument] = node.arguments;
					if (!argument || !ts.isStringLiteralLike(argument)) add(file, 'uses a non-static dynamic import');
					else if (isHostModule(argument.text, file, absoluteRoot))
						add(file, `dynamically imports host runtime module "${argument.text}"`);
				}
				const callee = accessPath(node.expression).join('.');
				if (callee === 'require' || callee.endsWith('.require')) {
					const [argument] = node.arguments;
					if (!argument || !ts.isStringLiteralLike(argument)) add(file, 'uses a non-static require call');
					else if (isHostModule(argument.text, file, absoluteRoot))
						add(file, `requires host runtime module "${argument.text}"`);
				}
			}
			if (ts.isNewExpression(node) && accessPath(node.expression).join('.') === 'Date' && node.arguments?.length === 0)
				add(file, 'reads ambient system time through "new Date()"');

			const path = accessPath(node);
			const dottedPath = path.join('.');
			if (environmentAccessPaths.has(dottedPath)) add(file, `reads ambient environment through "${dottedPath}"`);
			if (ts.isIdentifier(node) && forbiddenGlobals.has(node.text))
				add(file, `references host runtime global "${node.text}"`);

			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}
	return violations;
}

async function main() {
	const files = await sourceFiles(engineSource);
	const violations = await collectEngineBoundaryViolations(engineSource);
	if (violations.length) {
		process.stderr.write(`${violations.join('\n')}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write(`Engine boundary check passed for ${files.length} recursive source files.\n`);
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
