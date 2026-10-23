import { eligible, providers } from './core.js';
import { discoverAll, getOpenRouterSpendGuard } from './providers.js';
import { Octokit } from '@octokit/rest';
import { installationOctokit } from './github.js';
import { reviewPullRequest } from './review.js';
import { authorizeForkRemediation, isRemediationPullRequest, reserveReviewRound, finishReviewRound } from './state.js';
import { authorizeForkRemediationRequest } from './remediation-command.js';
import { applyVerifiedFreeOffers, applyVerifiedTrialOffers, loadTrustedConfig, parseReviewConfig } from './config.js';
import { readFile } from 'node:fs/promises';
const [command, ...args] = process.argv.slice(2);
async function main() {
	if (command === 'check') {
		console.log(JSON.stringify({ ok: true, node: process.versions.node, providers }));
		return;
	}
	if (command === 'config') {
		const file = args[args.indexOf('--file') + 1] ?? 'review-app.yml';
		const config = parseReviewConfig(await readFile(file, 'utf8'));
		console.log(
			JSON.stringify(
				{
					ok: true,
					file,
					mode: config.mode,
					providers: config.providers,
					verifiedFreeOffers: config.verifiedFreeOffers.length,
					verifiedTrialOffers: config.verifiedTrialOffers.length,
					automaticFixes: config.automaticFixes,
					autoMerge: config.autoMerge,
					validationWorkflow: config.validationWorkflow,
					validationCommands: config.validationCommands.length,
				},
				null,
				2,
			),
		);
		return;
	}
	if (command === 'discover') {
		const repoArg = args[args.indexOf('--repo') + 1];
		let freeOffers: import('./config.js').ReviewConfig['verifiedFreeOffers'] = [],
			trialOffers: import('./config.js').ReviewConfig['verifiedTrialOffers'] = [];
		if (repoArg) {
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repoArg))
				throw new Error('Usage: discover [--repo OWNER/NAME]');
			const [owner, name] = repoArg.split('/');
			let api: Octokit;
			const installation = process.env.GITHUB_INSTALLATION_ID,
				appId = process.env.GITHUB_APP_ID,
				privateKey = process.env.GITHUB_PRIVATE_KEY;
			if (installation || appId || privateKey) {
				if (!installation || !appId || !privateKey)
					throw new Error('GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY must be set together');
				api = await installationOctokit(Number(installation), repoArg, 'read');
			} else if (process.env.GH_TOKEN) api = new Octokit({ auth: process.env.GH_TOKEN });
			else throw new Error('Set GH_TOKEN or GitHub App credentials to load trusted repository offers');
			const { data: repository } = await api.repos.get({ owner: owner!, repo: name! });
			const policy = await loadTrustedConfig(api, owner!, name!, repository.default_branch);
			freeOffers = policy.verifiedFreeOffers;
			trialOffers = policy.verifiedTrialOffers;
		}
		const spendGuard = trialOffers.length ? await getOpenRouterSpendGuard() : null;
		const result = await discoverAll();
		console.log(
			JSON.stringify(
				Object.fromEntries(
					Object.entries(result).map(([provider, value]) => {
						const models = applyVerifiedTrialOffers(
							applyVerifiedFreeOffers(value.models, freeOffers),
							trialOffers,
							spendGuard,
						);
						return [
							provider,
							{
								status: value.status,
								eligible: models.filter((m) => eligible(m, new Date())),
								catalogCount: value.models.length,
								...(value.error ? { error: value.error } : {}),
							},
						];
					}),
				),
				null,
				2,
			),
		);
		return;
	}
	if (command === 'review') {
		const repo = args[args.indexOf('--repo') + 1],
			pr = Number(args[args.indexOf('--pr') + 1]);
		if (!repo || !Number.isInteger(pr) || pr < 1) throw new Error('Usage: review --repo OWNER/NAME --pr NUMBER');
		const [owner, name] = repo.split('/');
		let api: Octokit;
		const installation = process.env.GITHUB_INSTALLATION_ID,
			appId = process.env.GITHUB_APP_ID,
			privateKey = process.env.GITHUB_PRIVATE_KEY;
		if (installation || appId || privateKey) {
			if (!installation || !appId || !privateKey)
				throw new Error('GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY must be set together');
			api = await installationOctokit(Number(installation), repo);
		} else if (process.env.GH_TOKEN) api = new Octokit({ auth: process.env.GH_TOKEN });
		else throw new Error('Set GH_TOKEN or GitHub App credentials');
		const { data } = await api.pulls.get({ owner, repo: name, pull_number: pr });
		if (await isRemediationPullRequest(api, owner, name, pr)) {
			console.log(
				JSON.stringify({ skipped: true, reason: 'bot-remediation-pr-shares-original-round-budget' }, null, 2),
			);
			return;
		}
		const reservation = await reserveReviewRound(api, owner, name, pr, data.head.sha);
		if (!reservation.execute) {
			console.log(
				JSON.stringify({ round: reservation.round, skipped: true, reason: 'duplicate-or-stale-head' }, null, 2),
			);
			return;
		}
		try {
			const result = await reviewPullRequest(
				api,
				{ owner, repo: name, pr, sha: data.head.sha },
				'actions',
				reservation.round,
				reservation.leaseId,
			);
			await finishReviewRound(
				api,
				owner,
				name,
				pr,
				data.head.sha,
				reservation.leaseId,
				result.resolved ? 'complete' : 'needs-human',
			);
			console.log(JSON.stringify({ ...result, round: reservation.round }, null, 2));
		} catch (e) {
			await finishReviewRound(api, owner, name, pr, data.head.sha, reservation.leaseId, 'needs-human');
			throw e;
		}
		return;
	}
	if (command === 'remediate') {
		const repo = args[args.indexOf('--repo') + 1],
			pr = Number(args[args.indexOf('--pr') + 1]),
			actor = args[args.indexOf('--actor') + 1];
		if (!repo || !Number.isInteger(pr) || pr < 1 || !actor)
			throw new Error('Usage: remediate --repo OWNER/NAME --pr NUMBER --actor USER');
		const [owner, name] = repo.split('/');
		let api: Octokit;
		const installation = process.env.GITHUB_INSTALLATION_ID,
			appId = process.env.GITHUB_APP_ID,
			privateKey = process.env.GITHUB_PRIVATE_KEY;
		if (installation || appId || privateKey) {
			if (!installation || !appId || !privateKey)
				throw new Error('GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY must be set together');
			api = await installationOctokit(Number(installation), repo);
		} else if (process.env.GH_TOKEN) api = new Octokit({ auth: process.env.GH_TOKEN });
		else throw new Error('Set GitHub App credentials or GH_TOKEN');
		if (await isRemediationPullRequest(api, owner!, name!, pr)) {
			console.log(JSON.stringify({ skipped: true, reason: 'already-mapped-remediation-pull-request' }));
			return;
		}
		const { sha } = await authorizeForkRemediationRequest(api, owner!, name!, pr, actor, 'actions');
		await authorizeForkRemediation(api, owner!, name!, pr, sha);
		const reservation = await reserveReviewRound(api, owner!, name!, pr, sha, 8, 60 * 60 * 1000, false, true);
		if (!reservation.execute) {
			console.log(
				JSON.stringify({ round: reservation.round, skipped: true, reason: 'review-round-is-active-or-not-resumable' }),
			);
			return;
		}
		try {
			const result = await reviewPullRequest(
				api,
				{ owner: owner!, repo: name!, pr, sha },
				'actions',
				reservation.round,
				reservation.leaseId,
			);
			await finishReviewRound(
				api,
				owner!,
				name!,
				pr,
				sha,
				reservation.leaseId,
				result.resolved ? 'complete' : 'needs-human',
			);
			console.log(JSON.stringify({ ...result, round: reservation.round }, null, 2));
		} catch (error) {
			await finishReviewRound(api, owner!, name!, pr, sha, reservation.leaseId, 'needs-human').catch(() => {});
			throw error;
		}
		return;
	}
	if (command === 'serve') {
		await import('./server.js');
		return;
	}
	console.log(
		'review-app <check|config [--file PATH]|discover [--repo OWNER/NAME]|review --repo OWNER/NAME --pr NUMBER|remediate --repo OWNER/NAME --pr NUMBER --actor USER|serve>',
	);
}
main().catch((e) => {
	console.error(e instanceof Error ? e.message : 'operation failed');
	process.exitCode = 1;
});
