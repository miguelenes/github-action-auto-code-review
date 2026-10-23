import type { Octokit } from '@octokit/rest';
import { randomUUID } from 'node:crypto';
import type { FilePatch } from './agents.js';
import { defaultValidationCommands } from './config.js';
type Target = { owner: string; repo: string; pr: number; sha: string };
export async function applyPatches(
	api: Octokit,
	target: Target,
	patches: FilePatch[],
	beforeWrite?: () => Promise<void>,
	afterCommitCreated?: (commitSha: string) => Promise<void>,
): Promise<string> {
	if (!patches.length) throw new Error('no fixes were proposed');
	const { data: pr } = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (pr.head.sha !== target.sha) throw new Error('PR head changed before fix application');
	if (pr.head.repo?.full_name?.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase())
		throw new Error('automatic branch writes are disabled for fork PRs');
	if (!pr.head.ref || pr.head.ref.startsWith('-')) throw new Error('unsafe PR branch ref');
	const files = await api.paginate(api.pulls.listFiles, {
		owner: target.owner,
		repo: target.repo,
		pull_number: target.pr,
		per_page: 100,
	});
	const allowed = new Set(files.map((f) => f.filename));
	if (patches.some((p) => !allowed.has(p.path)))
		throw new Error('fixer patch includes a file outside the pull request diff');
	const { data: commit } = await api.git.getCommit({ owner: target.owner, repo: target.repo, commit_sha: target.sha });
	const listing = await api.git.getTree({
		owner: target.owner,
		repo: target.repo,
		tree_sha: commit.tree.sha,
		recursive: 'true',
	});
	if (listing.data.truncated) throw new Error('source tree is too large to safely apply patches');
	const modes = new Map(listing.data.tree.map((t) => [t.path, t.mode]));
	const blobs = await Promise.all(
		patches.map(async (p) => {
			const mode = modes.get(p.path);
			if (mode !== '100644' && mode !== '100755') throw new Error('patch target is not a regular text file');
			await beforeWrite?.();
			return {
				path: p.path,
				mode: mode as '100644' | '100755',
				type: 'blob' as const,
				sha: (
					await api.git.createBlob({ owner: target.owner, repo: target.repo, content: p.content, encoding: 'utf-8' })
				).data.sha,
			};
		}),
	);
	await beforeWrite?.();
	const tree = await api.git.createTree({
		owner: target.owner,
		repo: target.repo,
		base_tree: commit.tree.sha,
		tree: blobs,
	});
	await beforeWrite?.();
	const newCommit = await api.git.createCommit({
		owner: target.owner,
		repo: target.repo,
		message: 'Apply verified automated review fixes',
		tree: tree.data.sha,
		parents: [target.sha],
	});
	await afterCommitCreated?.(newCommit.data.sha);
	await beforeWrite?.();
	const current = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (current.data.head.sha !== target.sha) throw new Error('PR head changed before branch update');
	await api.git.updateRef({
		owner: target.owner,
		repo: target.repo,
		ref: `heads/${pr.head.ref}`,
		sha: newCommit.data.sha,
		force: false,
	});
	return newCommit.data.sha;
}
export async function createForkRemediationPullRequest(
	api: Octokit,
	target: Target,
	patches: FilePatch[],
	round: number,
	beforeWrite?: () => Promise<void>,
	onCreated?: (pr: number, sha: string, url: string) => Promise<void>,
): Promise<{ pr: number; sha: string }> {
	if (!patches.length) throw new Error('no fixes were proposed');
	const paths = patches.map((p) => p.path);
	if (
		new Set(paths).size !== paths.length ||
		paths.some(
			(path) =>
				path.startsWith('/') ||
				path.includes('\\') ||
				path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') ||
				// eslint-disable-next-line no-control-regex -- reject NUL and other control characters in repository paths
				/[\u0000-\u001f\u007f]/.test(path),
		)
	)
		throw new Error('fixer patch contains an unsafe repository path');
	const { data: original } = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (original.head.sha !== target.sha) throw new Error('PR head changed before fork remediation');
	if (
		!original.head.repo?.full_name ||
		original.head.repo.full_name.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()
	)
		throw new Error('fork remediation is only for a fork pull request');
	if (!original.base.ref || original.base.ref.startsWith('-')) throw new Error('unsafe pull request base ref');
	const files = await api.paginate(api.pulls.listFiles, {
		owner: target.owner,
		repo: target.repo,
		pull_number: target.pr,
		per_page: 100,
	});
	const changed = new Set(files.map((file) => file.filename));
	if (paths.some((path) => !changed.has(path)))
		throw new Error('fixer patch includes a file outside the pull request diff');
	const { data: commit } = await api.git.getCommit({ owner: target.owner, repo: target.repo, commit_sha: target.sha });
	const listing = await api.git.getTree({
		owner: target.owner,
		repo: target.repo,
		tree_sha: commit.tree.sha,
		recursive: 'true',
	});
	if (listing.data.truncated) throw new Error('source tree is too large to safely apply patches');
	const modes = new Map(listing.data.tree.map((item) => [item.path, item.mode]));
	const entries = await Promise.all(
		patches.map(async (patch) => {
			const mode = modes.get(patch.path);
			if (mode !== '100644' && mode !== '100755') throw new Error('patch target is not a regular text file');
			await beforeWrite?.();
			const blob = await api.git.createBlob({
				owner: target.owner,
				repo: target.repo,
				content: patch.content,
				encoding: 'utf-8',
			});
			return { path: patch.path, mode: mode as '100644' | '100755', type: 'blob' as const, sha: blob.data.sha };
		}),
	);
	await beforeWrite?.();
	const tree = await api.git.createTree({
		owner: target.owner,
		repo: target.repo,
		base_tree: commit.tree.sha,
		tree: entries,
	});
	await beforeWrite?.();
	const fixed = await api.git.createCommit({
		owner: target.owner,
		repo: target.repo,
		message: 'Apply verified automated review fixes',
		tree: tree.data.sha,
		parents: [target.sha],
	});
	const branch = `agent-review/pr-${target.pr}-round-${round}-${randomUUID().slice(0, 8)}`;
	await beforeWrite?.();
	const current = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (current.data.head.sha !== target.sha || current.data.base.sha !== original.base.sha)
		throw new Error('fork pull request changed before remediation branch creation');
	await api.git.createRef({ owner: target.owner, repo: target.repo, ref: `refs/heads/${branch}`, sha: fixed.data.sha });
	let createdPr: number | undefined,
		mapped = false;
	try {
		const latest = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
		if (latest.data.head.sha !== target.sha || latest.data.base.sha !== original.base.sha)
			throw new Error('fork pull request changed before remediation PR creation');
		await beforeWrite?.();
		const beforePullCreate = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
		if (beforePullCreate.data.head.sha !== target.sha || beforePullCreate.data.base.sha !== original.base.sha)
			throw new Error('fork pull request changed before remediation PR creation');
		const created = await api.pulls.create({
			owner: target.owner,
			repo: target.repo,
			title: `Automated fixes for PR #${target.pr}`,
			head: `${target.owner}:${branch}`,
			base: original.base.ref,
			draft: true,
			body: `Automated remediation for #${target.pr}, based on immutable head ${target.sha}.\n\nThis bot-owned pull request shares the original review's five-round budget.\n\n<!-- agent-review-remediation:${target.pr}:${target.sha} -->`,
		});
		createdPr = created.data.number;
		await onCreated?.(createdPr, fixed.data.sha, created.data.html_url);
		mapped = true;
		const beforeReady = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
		if (beforeReady.data.head.sha !== target.sha || beforeReady.data.base.sha !== original.base.sha)
			throw new Error('fork pull request changed before remediation PR was marked ready');
		await beforeWrite?.();
		await api.pulls.update({ owner: target.owner, repo: target.repo, pull_number: createdPr, draft: false });
		return { pr: createdPr, sha: fixed.data.sha };
	} catch (error) {
		if (createdPr === undefined)
			await api.git.deleteRef({ owner: target.owner, repo: target.repo, ref: `heads/${branch}` }).catch(() => {});
		else if (!mapped) {
			await api.pulls
				.update({ owner: target.owner, repo: target.repo, pull_number: createdPr, state: 'closed' })
				.catch(() => {});
			await api.git.deleteRef({ owner: target.owner, repo: target.repo, ref: `heads/${branch}` }).catch(() => {});
		}
		throw error;
	}
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function validateCommit(
	api: Octokit,
	target: Target,
	headSha: string,
	timeoutMs = 300_000,
	workflow = 'validate-review.yml',
	commands: readonly string[] = defaultValidationCommands,
	trustedBaseSha?: string,
	beforeDispatch?: () => Promise<void>,
): Promise<{ passed: boolean; runUrl?: string }> {
	const { data: pr } = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	const baseSha = trustedBaseSha ?? pr.base.sha;
	if (pr.base.sha !== baseSha) throw new Error('trusted base changed before isolated validation');
	await beforeDispatch?.();
	await api.actions.createWorkflowDispatch({
		owner: target.owner,
		repo: target.repo,
		workflow_id: workflow,
		ref: pr.base.ref,
		inputs: {
			pull_number: String(target.pr),
			head_sha: headSha,
			base_ref: pr.base.ref,
			base_sha: baseSha,
			validation_commands: commands.join('\n'),
		},
	});
	const title = `Validate PR ${target.pr} @ ${headSha}`,
		deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const runs = await api.actions.listWorkflowRuns({
			owner: target.owner,
			repo: target.repo,
			workflow_id: workflow,
			event: 'workflow_dispatch',
			per_page: 100,
		});
		const run = runs.data.workflow_runs.find((r) => r.display_title === title);
		if (run?.status === 'completed') return { passed: run.conclusion === 'success', runUrl: run.html_url };
		await pause(5000);
	}
	throw new Error('isolated validation workflow timed out');
}

export async function enableNativeAutoMerge(
	api: Octokit,
	target: Target,
	method: 'MERGE' | 'SQUASH' | 'REBASE',
	beforeEnable?: () => Promise<void>,
): Promise<void> {
	const { data: pr } = await api.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pr });
	if (pr.head.sha !== target.sha) throw new Error('PR head changed before enabling auto-merge');
	await beforeEnable?.();
	const result = (await api.request('POST /graphql', {
		query:
			'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { autoMergeRequest { enabledAt } } } }',
		variables: { id: pr.node_id, method },
	})) as {
		data?: { enablePullRequestAutoMerge?: { pullRequest?: { autoMergeRequest?: { enabledAt?: string | null } } } };
		errors?: unknown[];
	};
	if (result.errors?.length || !result.data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest)
		throw new Error('GitHub did not enable native pull request auto-merge');
}
