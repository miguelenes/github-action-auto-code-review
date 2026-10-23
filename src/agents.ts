import { readFile } from 'node:fs/promises';
import {
	confirmedFindings,
	independentReview as runIndependentReview,
	parseFilePatches,
	parseFindings,
	proposeFixes as runProposeFixes,
	verifyFixes as runVerifyFixes,
	type FilePatch,
	type Inference,
	type Model,
	type RolePrompts,
} from '@miguelenes/reviewer-engine';
import { completeModel } from './inference.js';

const rolePaths = ['reviewer', 'challenger', 'fixer', 'verifier'] as const;
type Role = (typeof rolePaths)[number];
export { confirmedFindings, parseFilePatches, parseFindings };
export type { FilePatch };

export async function loadRole(role: Role): Promise<string> {
	return readFile(new URL(`../runtime/skills/${role}.md`, import.meta.url), 'utf8');
}

async function loadRoles(): Promise<RolePrompts> {
	const [reviewer, challenger, fixer, verifier] = await Promise.all(rolePaths.map(loadRole));
	return { reviewer, challenger, fixer, verifier };
}

type Complete = Inference;
export async function independentReview(
	diff: string,
	models: Model[],
	evidenceContext = '',
	complete: Complete = completeModel,
) {
	return runIndependentReview({
		diff,
		models,
		evidenceContext,
		rolePrompts: await loadRoles(),
		complete,
		clock: { now: () => new Date() },
	});
}

export async function proposeFixes(
	findings: import('./core.js').Finding[],
	diff: string,
	sourceFiles: Record<string, string>,
	model: Model,
	allowed: Set<string>,
): Promise<FilePatch[]> {
	return runProposeFixes({
		findings,
		diff,
		sourceFiles,
		model,
		allowed,
		rolePrompts: { fixer: await loadRole('fixer') },
		complete: completeModel,
	});
}

export async function verifyFixes(
	findings: import('./core.js').Finding[],
	patches: FilePatch[],
	sourceFiles: Record<string, string>,
	model: Model,
): Promise<boolean> {
	return runVerifyFixes({
		findings,
		patches,
		sourceFiles,
		model,
		rolePrompts: { verifier: await loadRole('verifier') },
		complete: completeModel,
	});
}
