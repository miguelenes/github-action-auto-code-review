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
	type CredentialSource,
	type Inference,
	type InferencePort,
	type Model,
	type Provider,
	type ReviewRole,
	type RolePromptSource,
	type ReviewPersistence,
} from '@miguelenes/reviewer-engine';
import { completeModel } from './inference.js';

type Role = ReviewRole;
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

const rolePromptSource: RolePromptSource = { get: loadRole };
const providerCredentialNames: Record<Provider, string> = {
	openrouter: 'OPENROUTER_API_KEY',
	nvidia: 'NVIDIA_API_KEY',
	groq: 'GROQ_API_KEY',
	gemini: 'GEMINI_API_KEY',
	cerebras: 'CEREBRAS_API_KEY',
	mistral: 'MISTRAL_API_KEY',
	cloudflare: 'CLOUDFLARE_API_TOKEN',
	'github-models': 'GITHUB_TOKEN',
};
const credentialSource: CredentialSource = {
	async get(provider) {
		return process.env[providerCredentialNames[provider]];
	},
};
const inferencePort: InferencePort = {
	async complete(model, system, prompt) {
		return completeModel(model, system, prompt, fetch, await credentialSource.get(model.provider));
	},
};

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
		rolePromptSource,
		inferencePort: complete === completeModel ? inferencePort : { complete },
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
		rolePromptSource,
		inferencePort,
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
		rolePromptSource,
		inferencePort,
	};
	return checkpoint ? resumableVerifyFixes({ ...input, ...checkpoint, clock, digest }) : runVerifyFixes(input);
}
