import type { Octokit } from '@octokit/rest';
import { CatalogAdapter, getOpenRouterSpendGuard } from './providers.js';
import { independentReview, proposeFixes, verifyFixes } from './agents.js';
import { applyPatches, createForkRemediationPullRequest, validateCommit, enableNativeAutoMerge } from './executor.js';
import { applyVerifiedFreeOffers, applyVerifiedTrialOffers, loadTrustedConfig } from './config.js';
import {
	attachFixCommit,
	attachRemediationPullRequest,
	forkRemediationAuthorized,
	refreshReviewLease,
} from './state.js';
import { eligible, mergeReady, type Finding, type Model } from './core.js';
import { changedLines, collectReviewSupplement } from './evidence.js';
import { assessReviewCapabilities, MAX_CAPABILITY_CANDIDATES } from './capabilities.js';
type Repo = { owner: string; repo: string; pr: number; sha: string };
type ExecutionMode = 'hosted' | 'actions';
function objectText(x: unknown): string {
	return typeof x === 'string' ? x : JSON.stringify(x);
}
const SUMMARY_MARKER = '<!-- open-source-agent-reviewer-summary -->';
export async function publishSummary(
	api: Octokit,
	target: Repo,
	round: number,
	model: string,
	findings: Finding[],
	coverage: 'complete' | 'incomplete',
	resolved: boolean,
	details: string,
	beforeWrite?: () => Promise<void>,
): Promise<void> {
	const status = resolved
		? 'Review complete; no unresolved validated findings.'
		: 'Review blocked; maintainer attention is required.';
	const body = [
		SUMMARY_MARKER,
		`## Automated review — round ${round}/5`,
		``,
		status,
		``,
		`- Evidence coverage: **${coverage}**`,
		`- Validated findings: **${findings.length}**`,
		`- Providers and models: ${model || 'none'}`,
		``,
		`${details}`,
	].join('\n');
	const comments = await api.paginate(api.issues.listComments, {
		owner: target.owner,
		repo: target.repo,
		issue_number: target.pr,
		per_page: 100,
	});
	const previous = comments.find((comment) => comment.body?.includes(SUMMARY_MARKER));
	const { data: pr } = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (pr.head.sha !== target.sha) throw new Error('stale pull request head before summary update');
	await beforeWrite?.();
	const latest = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (latest.data.head.sha !== target.sha) throw new Error('stale pull request head before summary update');
	if (previous)
		await api.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: previous.id, body });
	else await api.issues.createComment({ owner: target.owner, repo: target.repo, issue_number: target.pr, body });
}
export function addedLines(diff: string): Map<string, Set<number>> {
	return changedLines(diff);
}
export function anchorFindings(
	findings: Finding[],
	anchors: Map<string, Set<number>>,
): { valid: Finding[]; rejected: number } {
	const valid = findings.filter((f) => anchors.get(f.path)?.has(f.line));
	return { valid, rejected: findings.length - valid.length };
}
export function capabilityCandidates(
	models: Model[],
	preferred: string[],
	requiredContext: number,
	now: Date,
): Model[] {
	const rank = (id: string) => (preferred.indexOf(id) === -1 ? Number.MAX_SAFE_INTEGER : preferred.indexOf(id));
	const sorted = models
		.filter(
			(m) =>
				eligible(m, now) && m.capabilities.chat === true && m.context !== undefined && m.context >= requiredContext,
		)
		.sort((a, b) => rank(a.id) - rank(b.id) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	const selected: Model[] = [],
		providers = new Set<string>();
	for (const model of sorted) {
		if (providers.has(model.provider)) continue;
		selected.push(model);
		providers.add(model.provider);
		if (selected.length >= MAX_CAPABILITY_CANDIDATES) break;
	}
	for (const model of sorted) {
		if (selected.length >= MAX_CAPABILITY_CANDIDATES) break;
		if (!selected.some((candidate) => candidate.provider === model.provider && candidate.id === model.id))
			selected.push(model);
	}
	return selected;
}
export function selectReviewModels(models: Model[], preferred: string[], requiredContext: number, now: Date): Model[] {
	const rank = (id: string) => (preferred.indexOf(id) === -1 ? Number.MAX_SAFE_INTEGER : preferred.indexOf(id));
	const sorted = models
		.filter(
			(m) =>
				eligible(m, now) &&
				m.capabilities.chat === true &&
				m.capabilities.codeReview === true &&
				m.context !== undefined &&
				m.context >= requiredContext,
		)
		.sort((a, b) => rank(a.id) - rank(b.id) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	const unique = sorted.filter((m, i, a) => a.findIndex((x) => x.provider === m.provider && x.id === m.id) === i);
	const selected: Model[] = [];
	const providers = new Set<string>();
	for (const m of unique) {
		if (providers.has(m.provider)) continue;
		selected.push(m);
		providers.add(m.provider);
		if (providers.size >= 2) break;
	}
	for (const m of unique) {
		if (selected.length >= 3) break;
		if (!selected.some((x) => x.provider === m.provider && x.id === m.id)) selected.push(m);
	}
	if (selected.length < 3 || providers.size < 2)
		throw new Error(
			'review requires three eligible models that passed the review capability check across at least two providers with sufficient context',
		);
	return [...selected, ...unique.filter((m) => !selected.some((x) => x.provider === m.provider && x.id === m.id))];
}
export async function reviewPullRequest(
	api: Octokit,
	target: Repo,
	mode: ExecutionMode,
	round: number,
	leaseId: string,
): Promise<{
	model: string;
	findings: Finding[];
	disputed: number;
	resolved: boolean;
	coverage: 'complete' | 'incomplete';
}> {
	const { data: pr } = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (pr.head.sha !== target.sha) throw new Error('stale pull request head');
	const trustedBaseSha = pr.base.sha;
	const prepareWrite = async (expectedHead: string, expectedPr = target.pr) => {
		await refreshReviewLease(api, target.owner, target.repo, target.pr, target.sha, round, leaseId);
		const current = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
		if (current.data.base.sha !== trustedBaseSha) throw new Error('trusted base changed during review');
		if (expectedPr === target.pr) {
			if (current.data.head.sha !== expectedHead) throw new Error('stale pull request head before write');
		} else {
			const remediation = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: expectedPr });
			if (remediation.data.head.sha !== expectedHead || remediation.data.base.sha !== trustedBaseSha)
				throw new Error('stale remediation pull request before write');
		}
	};
	const policy = await loadTrustedConfig(api, target.owner, target.repo, pr.base.sha);
	if (policy.mode !== mode) throw new Error('configured execution mode does not match this review adapter');
	if (!policy.providers.length) throw new Error('no inference providers are enabled by trusted base policy');
	if (policy.allowedRepositories.length && !policy.allowedRepositories.includes(`${target.owner}/${target.repo}`))
		throw new Error('repository is not enabled by trusted base policy');
	const patch = await api.pulls.get({
		owner: target.owner,
		repo: target.repo,
		pull_number: target.pr,
		mediaType: { format: 'diff' },
	});
	const diff = objectText(patch.data);
	if (diff.length > 100000)
		throw new Error('pull request diff exceeds the 100 KB evidence limit; review marked incomplete');
	const anchors = addedLines(diff);
	const supplement = await collectReviewSupplement(api, {
		owner: target.owner,
		repo: target.repo,
		pr: target.pr,
		headSha: target.sha,
		prBody: pr.body,
		diff,
	});
	const discovered = await Promise.all(
		policy.providers.map(async (provider) => {
			try {
				return await new CatalogAdapter(provider).discover();
			} catch {
				return [];
			}
		}),
	);
	const requiredContext = Math.ceil(diff.length / 3) + 10_000;
	const spendGuard = policy.verifiedTrialOffers.length ? await getOpenRouterSpendGuard() : null;
	const eligibleModels = applyVerifiedTrialOffers(
		applyVerifiedFreeOffers(discovered.flat(), policy.verifiedFreeOffers),
		policy.verifiedTrialOffers,
		spendGuard,
	);
	const now = new Date();
	const probeCandidates = capabilityCandidates(eligibleModels, policy.preferredModels, requiredContext, now);
	const assessedCandidates = await assessReviewCapabilities(probeCandidates);
	const candidates = selectReviewModels(assessedCandidates, policy.preferredModels, requiredContext, now);
	const { findings, used, disputed: initialDisputed } = await independentReview(diff, candidates, supplement.context);
	let disputed = initialDisputed;
	const modelUses = new Map<string, { model: Model; roles: string[] }>();
	const noteModel = (model: Model, role: string) => {
		const key = `${model.provider}/${model.id}`,
			record = modelUses.get(key) ?? { model, roles: [] };
		if (!record.roles.includes(role)) record.roles.push(role);
		modelUses.set(key, record);
	};
	used.forEach((model, index) =>
		noteModel(model, ['primary reviewer', 'security reviewer', 'challenger'][index] ?? 'reviewer'),
	);
	const reasonFor = (model: Model) =>
		`passed this run's positive security-defect and clean-code probes; ${model.provider === 'openrouter' ? (model.inputUsdPerMillion === 0 && model.outputUsdPerMillion === 0 ? 'request is capped at $0 with provider fallback disabled' : `owner-verified trial cap of $${model.trialCreditBudgetUsd} through ${model.trialExpiresAt}, with a finite non-resetting provider key limit`) : `owner-verified free-tier offer observed ${model.accountTierEvidence?.observedAt ?? 'unknown'}`}`;
	const { valid, rejected } = anchorFindings(findings, anchors);
	const fresh = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (fresh.data.head.sha !== target.sha) throw new Error('head changed during review');
	let resolved = valid.length === 0 && rejected === 0 && disputed === 0 && supplement.complete;
	let coverageComplete = supplement.complete && rejected === 0;
	let summarySha = target.sha,
		remediationPr: number | undefined,
		remediationUrl: string | undefined,
		readinessBlocker: string | undefined;
	const modelDisclosure = `Independent review models: ${used.map((m) => `${m.provider}/${m.id} — ${reasonFor(m)}`).join('; ')}.`;
	const coverageDisclosure = supplement.complete
		? 'Evidence coverage complete.'
		: `Evidence coverage incomplete: ${supplement.omissions.join('; ')}. Merge readiness is blocked.`;
	const disclosure = `${modelDisclosure}\n${coverageDisclosure}`;
	if (valid.length) {
		await prepareWrite(target.sha);
		await api.pulls.createReview({
			owner: target.owner,
			repo: target.repo,
			pull_number: target.pr,
			commit_id: target.sha,
			event: 'REQUEST_CHANGES',
			body: disclosure,
			comments: valid.slice(0, 100).map((f) => ({
				path: f.path,
				line: f.line,
				side: 'RIGHT' as const,
				body: `**${f.severity.toUpperCase()} — ${f.title}**\n\nCategory: ${f.category}\n\n${f.impact}\n\nSuggested remediation: ${f.remediation}\n\nEvidence: ${f.evidence}`,
			})),
		});
		if (valid.length > 100) {
			const remainder = valid
				.slice(100)
				.map((f) => `- ${f.severity.toUpperCase()} [${f.category}] ${f.path}:${f.line}: ${f.title} — ${f.impact}`)
				.join('\n');
			await prepareWrite(target.sha);
			await api.issues.createComment({
				owner: target.owner,
				repo: target.repo,
				issue_number: target.pr,
				body: `Additional verified findings omitted from inline review due to GitHub's comment limit:\n${remainder}`,
			});
		}
	} else if (rejected || disputed || !supplement.complete) {
		await prepareWrite(target.sha);
		const blockers = [
			rejected ? `${rejected} proposed finding(s) could not be anchored to added lines` : undefined,
			disputed ? `${disputed} reviewer finding(s) remain disputed by the challenger` : undefined,
			!supplement.complete ? `evidence coverage is incomplete: ${supplement.omissions.join('; ')}` : undefined,
		]
			.filter(Boolean)
			.join('; ');
		await api.issues.createComment({
			owner: target.owner,
			repo: target.repo,
			issue_number: target.pr,
			body: `${disclosure}\n\nReview is blocked: ${blockers}. A maintainer must assess this result; auto-merge is blocked.`,
		});
	} else {
		await prepareWrite(target.sha);
		await api.issues.createComment({
			owner: target.owner,
			repo: target.repo,
			issue_number: target.pr,
			body: `${disclosure}\n\nNo actionable findings were confirmed. This is not a verified clean bill of health.`,
		});
		if (policy.autoMerge) {
			const checks = await validateCommit(
				api,
				target,
				target.sha,
				policy.validationTimeoutSeconds * 1000,
				policy.validationWorkflow,
				policy.validationCommands,
				trustedBaseSha,
				() => prepareWrite(target.sha),
			);
			const ready = mergeReady(
				{
					pr: target.pr,
					headSha: target.sha,
					round,
					phase: 'complete',
					coverage: coverageComplete ? 'complete' : 'incomplete',
					findings: [],
					disputed,
					models: [],
				},
				checks.passed,
			);
			if (!ready) {
				resolved = false;
				readinessBlocker = 'review, evidence coverage, disputes, or isolated validation is incomplete';
			} else
				try {
					await enableNativeAutoMerge(api, target, policy.mergeMethod, () => prepareWrite(target.sha));
					resolved = true;
				} catch (error) {
					resolved = false;
					readinessBlocker =
						error instanceof Error ? error.message : 'GitHub did not enable native pull request auto-merge';
				}
		}
	}
	if (valid.length && policy.automaticFixes) {
		try {
			const fixer = candidates[3] ?? used[1]!;
			noteModel(fixer, 'fixer');
			const sourceFiles: Record<string, string> = {};
			for (const path of new Set(valid.map((f) => f.path))) {
				const file = await api.repos.getContent({ owner: target.owner, repo: target.repo, path, ref: target.sha });
				if (Array.isArray(file.data) || file.data.type !== 'file' || file.data.encoding !== 'base64')
					throw new Error('finding source is not an ordinary text file');
				const content = Buffer.from(file.data.content, 'base64').toString('utf8');
				if (content.includes('\0') || Buffer.byteLength(content) > 500_000)
					throw new Error('finding source cannot be safely patched');
				sourceFiles[path] = content;
			}
			const patches = await proposeFixes(valid, diff, sourceFiles, fixer, new Set(Object.keys(sourceFiles)));
			const headRepo = pr.head.repo?.full_name?.toLowerCase(),
				sameRepo = headRepo === `${target.owner}/${target.repo}`.toLowerCase();
			let fixSha: string,
				verificationTarget: Repo = target;
			if (sameRepo) {
				fixSha = await applyPatches(
					api,
					target,
					patches,
					() => prepareWrite(target.sha),
					(sha) => attachFixCommit(api, target.owner, target.repo, target.pr, target.sha, sha, leaseId),
				);
				summarySha = fixSha;
			} else {
				if (!(await forkRemediationAuthorized(api, target.owner, target.repo, target.pr, target.sha, leaseId)))
					throw new Error('fork PR remediation requires the /review-app remediate maintainer command');
				const remediation = await createForkRemediationPullRequest(
					api,
					target,
					patches,
					round,
					() => prepareWrite(target.sha),
					async (number, sha, url) => {
						remediationPr = number;
						remediationUrl = url;
						await attachFixCommit(api, target.owner, target.repo, target.pr, target.sha, sha, leaseId);
						await attachRemediationPullRequest(api, target.owner, target.repo, target.pr, target.sha, number, leaseId);
					},
				);
				fixSha = remediation.sha;
				remediationPr = remediation.pr;
				verificationTarget = { ...target, pr: remediation.pr, sha: fixSha };
				const created = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: remediation.pr });
				remediationUrl = created.data.html_url;
			}
			const checks = await validateCommit(
				api,
				verificationTarget,
				fixSha,
				policy.validationTimeoutSeconds * 1000,
				policy.validationWorkflow,
				policy.validationCommands,
				trustedBaseSha,
				() => prepareWrite(fixSha, verificationTarget.pr),
			);
			const latest = await api.pulls.get({
				owner: target.owner,
				repo: target.repo,
				pull_number: verificationTarget.pr,
			});
			if (latest.data.head.sha !== fixSha) throw new Error('PR head changed during validation');
			const verifier = candidates[4] ?? used[0]!;
			if (checks.passed) noteModel(verifier, 'fix verifier');
			const verified = checks.passed && (await verifyFixes(valid, patches, sourceFiles, verifier));
			const latestDiff = await api.pulls.get({
				owner: target.owner,
				repo: target.repo,
				pull_number: verificationTarget.pr,
				mediaType: { format: 'diff' },
			});
			const fixSupplement = await collectReviewSupplement(api, {
				owner: target.owner,
				repo: target.repo,
				pr: verificationTarget.pr,
				headSha: fixSha,
				prBody: latest.data.body,
				diff: objectText(latestDiff.data),
			});
			const finalReview = await independentReview(objectText(latestDiff.data), candidates, fixSupplement.context);
			disputed = Math.max(disputed, finalReview.disputed);
			finalReview.used.forEach((model, index) =>
				noteModel(model, `post-fix ${['reviewer', 'security reviewer', 'challenger'][index] ?? 'reviewer'}`),
			);
			coverageComplete = coverageComplete && fixSupplement.complete;
			const verifiedRound = mergeReady(
				{
					pr: target.pr,
					headSha: fixSha,
					round,
					phase: 'complete',
					coverage: coverageComplete ? 'complete' : 'incomplete',
					findings: finalReview.findings,
					disputed,
					models: [],
				},
				checks.passed && verified,
			);
			resolved = verifiedRound;
			if (resolved && policy.autoMerge) {
				try {
					await enableNativeAutoMerge(api, verificationTarget, policy.mergeMethod, () =>
						prepareWrite(fixSha, verificationTarget.pr),
					);
				} catch (error) {
					resolved = false;
					readinessBlocker =
						error instanceof Error ? error.message : 'GitHub did not enable native pull request auto-merge';
				}
			}
			await prepareWrite(remediationPr ? target.sha : fixSha);
			await api.issues.createComment({
				owner: target.owner,
				repo: target.repo,
				issue_number: target.pr,
				body: `Automated fix commit: ${fixSha}.${remediationUrl ? ` Bot-owned remediation PR: ${remediationUrl}.` : ''} Isolated validation: ${checks.passed ? 'passed' : 'failed'}${checks.runUrl ? ` ([run](${checks.runUrl}))` : ''}. Independent fix verification: ${verified ? 'passed' : 'failed'}.`,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : 'fix attempt failed';
			await prepareWrite(summarySha);
			await api.issues.createComment({
				owner: target.owner,
				repo: target.repo,
				issue_number: target.pr,
				body: `Automated fix attempt stopped for safety: ${message}.${remediationUrl ? ` Draft remediation PR: ${remediationUrl}.` : ''} The inline findings remain open for a maintainer.`,
			});
		}
	}
	const model = [...modelUses.values()]
		.map(({ model, roles }) => `${model.provider}/${model.id} [${roles.join(', ')}; ${reasonFor(model)}]`)
		.join('; ');
	const finalCoverage = coverageComplete ? 'complete' : 'incomplete';
	await publishSummary(
		api,
		{ ...target, sha: summarySha },
		round,
		model,
		valid,
		finalCoverage,
		resolved,
		resolved
			? `All available review, fix, and verification steps completed.${remediationUrl ? ` Bot-owned remediation PR: ${remediationUrl}.` : ''}`
			: `Blocking state: ${[disputed ? `${disputed} reviewer finding(s) remain disputed by the challenger` : undefined, finalCoverage === 'incomplete' ? 'evidence coverage is incomplete' : undefined, valid.length ? 'validated findings remain unresolved' : undefined, readinessBlocker].filter(Boolean).join('; ') || 'review or validation did not establish readiness'}.${remediationUrl ? ` Remediation PR: ${remediationUrl}.` : ''}`,
		() => prepareWrite(summarySha),
	);
	return { model, findings: valid, disputed, resolved, coverage: finalCoverage };
}
