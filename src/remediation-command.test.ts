import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import {
	authorizeForkRemediationRequest,
	canAuthorizeForkRemediation,
	isForkRemediationCommand,
} from './remediation-command.js';

test('remediation command matching is exact and ignores surrounding whitespace', () => {
	assert.equal(isForkRemediationCommand(' /review-app remediate\n'), true);
	assert.equal(isForkRemediationCommand('/review-app remediate please'), false);
	assert.equal(isForkRemediationCommand({ body: '/review-app remediate' }), false);
});

test('only repository writers can authorize fork remediation', () => {
	assert.equal(['admin', 'maintain', 'write'].every(canAuthorizeForkRemediation), true);
	assert.equal(['triage', 'read', 'none', undefined].some(canAuthorizeForkRemediation), false);
});

function apiFixture(
	permission: 'admin' | 'maintain' | 'write' | 'triage' = 'write',
	headRepo = 'contributor/repo',
	yaml = 'mode: hosted\nautomaticFixes: true\n',
) {
	const calls: string[] = [];
	const api = {
		repos: {
			async getCollaboratorPermissionLevel() {
				calls.push('permission');
				return { data: { permission } };
			},
			async getContent() {
				calls.push('policy');
				return { data: { type: 'file', encoding: 'base64', content: Buffer.from(yaml).toString('base64') } };
			},
		},
		pulls: {
			async get() {
				calls.push('pull');
				return {
					data: {
						state: 'open',
						draft: false,
						head: { sha: 'head-sha', repo: { full_name: headRepo } },
						base: { sha: 'base-sha' },
					},
				};
			},
		},
	};
	return { api: api as unknown as Octokit, calls };
}

test('fork remediation authorization uses maintainer permission and trusted base policy', async () => {
	const fixture = apiFixture();
	assert.deepEqual(await authorizeForkRemediationRequest(fixture.api, 'owner', 'repo', 7, 'maintainer'), {
		sha: 'head-sha',
	});
	assert.deepEqual(fixture.calls, ['permission', 'pull', 'policy']);
});

test('fork remediation authorization rejects unauthorized or non-fork requests', async () => {
	await assert.rejects(
		authorizeForkRemediationRequest(apiFixture('triage').api, 'owner', 'repo', 7, 'reviewer'),
		/requires repository write/,
	);
	await assert.rejects(
		authorizeForkRemediationRequest(apiFixture('write', 'owner/repo').api, 'owner', 'repo', 7, 'reviewer'),
		/only available for fork/,
	);
	await assert.rejects(
		authorizeForkRemediationRequest(
			apiFixture('write', 'contributor/repo', 'mode: actions\nautomaticFixes: true\n').api,
			'owner',
			'repo',
			7,
			'reviewer',
		),
		/hosted execution mode/,
	);
	await assert.rejects(
		authorizeForkRemediationRequest(
			apiFixture('write', 'contributor/repo', 'mode: hosted\nautomaticFixes: false\n').api,
			'owner',
			'repo',
			7,
			'reviewer',
		),
		/automatic fixes are disabled/,
	);
});
