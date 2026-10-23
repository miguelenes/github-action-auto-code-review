import type { Octokit } from '@octokit/rest';
import { loadTrustedConfig } from './config.js';

export const forkRemediationCommand = '/review-app remediate';

export function isForkRemediationCommand(body: unknown): boolean {
	return typeof body === 'string' && body.trim() === forkRemediationCommand;
}

export function canAuthorizeForkRemediation(permission: unknown): boolean {
	return permission === 'admin' || permission === 'maintain' || permission === 'write';
}

export async function authorizeForkRemediationRequest(
	api: Octokit,
	owner: string,
	repo: string,
	pr: number,
	actor: unknown,
	expectedMode: 'hosted' | 'actions' = 'hosted',
): Promise<{ sha: string }> {
	if (typeof actor !== 'string' || !/^\S{1,100}$/.test(actor)) throw new Error('a valid GitHub username is required');
	const membership = await api.repos.getCollaboratorPermissionLevel({ owner, repo, username: actor });
	if (!canAuthorizeForkRemediation(membership.data.permission))
		throw new Error('fork remediation requires repository write, maintain, or admin permission');
	const { data: pull } = await api.pulls.get({ owner, repo, pull_number: pr });
	if (pull.state !== 'open' || pull.draft) throw new Error('fork remediation requires an open, ready pull request');
	const headRepository = pull.head.repo?.full_name?.toLowerCase();
	if (!headRepository || headRepository === `${owner}/${repo}`.toLowerCase())
		throw new Error('maintainer remediation is only available for fork pull requests');
	const policy = await loadTrustedConfig(api, owner, repo, pull.base.sha);
	if (policy.mode !== expectedMode) throw new Error(`fork remediation commands require ${expectedMode} execution mode`);
	if (policy.allowedRepositories.length && !policy.allowedRepositories.includes(`${owner}/${repo}`))
		throw new Error('repository is not enabled by trusted base policy');
	if (!policy.automaticFixes) throw new Error('automatic fixes are disabled by trusted base policy');
	return { sha: pull.head.sha };
}
