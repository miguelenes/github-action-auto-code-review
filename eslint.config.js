import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
	{ ignores: ['dist/**', 'node_modules/**', '.wrangler/**', 'vendor/**', 'packages/**/dist/**'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.serviceworker } },
		rules: { 'no-undef': 'off' },
	},
	prettier,
];
