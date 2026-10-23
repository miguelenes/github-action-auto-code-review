import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
	confirmedFindings,
	independentReview as runIndependentReview,
	resumableIndependentReview,
	parseFilePatches,
	parseFindings,
	proposeFixes as runProposeFixes,
	resumableProposeFixes,
	verifyFixes as runVerifyFixes,
	resumableVerifyFixes,
	type FilePatch,
	type Inference,
	type Model,
	type RolePrompts,
	type ReviewPersistence,
} from '@miguelenes/reviewer-engine';
import { completeModel } from './inference.js';

const rolePaths = ['reviewer', 'challenger', 'fixer', 'verifier'] as const;
type Role = (typeof rolePaths)[number];
export { confirmedFindings, parseFilePatches, parseFindings };
export type { FilePatch };

export type CheckpointContext = {
	jobId: string;
	headSha: string;
	persistence: ReviewPersistence;
};

const clock = { now: () => new Date() };
const digest = {
	async sha256(value: string) {
		return createHash('sha256').update(value).digest('hex');
	},
};

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
	checkpoint?: CheckpointContext,
) {
	const input = {
		diff,
		models,
		evidenceContext,
		rolePrompts: await loadRoles(),
		complete,
		clock,
	};
	return checkpoint ? resumableIndependentReview({ ...input, ...checkpoint, digest }) : runIndependentReview(input);
}

export async function proposeFixes(
	findings: import('./core.js').Finding[],
	diff: string,
	sourceFiles: Record<string, string>,
	model: Model,
	allowed: Set<string>,
	checkpoint?: CheckpointContext,
): Promise<FilePatch[]> {
	const input = {
		findings,
		diff,
		sourceFiles,
		model,
		allowed,
		rolePrompts: { fixer: await loadRole('fixer') },
		complete: completeModel,
	};
	return checkpoint ? resumableProposeFixes({ ...input, ...checkpoint, clock, digest }) : runProposeFixes(input);
}

export async function verifyFixes(
	findings: import('./core.js').Finding[],
	patches: FilePatch[],
	sourceFiles: Record<string, string>,
	model: Model,
	checkpoint?: CheckpointContext,
): Promise<boolean> {
	const input = {
		findings,
		patches,
		sourceFiles,
		model,
		rolePrompts: { verifier: await loadRole('verifier') },
		complete: completeModel,
	};
	return checkpoint ? resumableVerifyFixes({ ...input, ...checkpoint, clock, digest }) : runVerifyFixes(input);
}
