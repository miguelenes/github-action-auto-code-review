import { createSign, createHmac, timingSafeEqual } from 'node:crypto';
import { Octokit } from '@octokit/rest';
export function verifySignature(secret: string, body: Buffer, signature: string | string[] | undefined): boolean {
	if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
	const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
	return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
export function appJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
	const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
	const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iat: now - 30, exp: now + 540, iss: appId });
	const signer = createSign('RSA-SHA256');
	signer.update(unsigned);
	return unsigned + '.' + signer.sign(privateKey, 'base64url');
}
export function installationTokenOptions(
	installationId: number,
	repository: string,
	scope: 'review' | 'read' = 'review',
) {
	if (!Number.isSafeInteger(installationId) || installationId < 1)
		throw new Error('a valid GitHub App installation ID is required');
	if (!/^(?=.{3,201}$)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))
		throw new Error('a valid OWNER/REPOSITORY is required to scope the installation token');
	const permissions =
		scope === 'read'
			? { contents: 'read' as const }
			: {
					pull_requests: 'write' as const,
					contents: 'write' as const,
					issues: 'write' as const,
					actions: 'write' as const,
				};
	return { installation_id: installationId, repositories: [repository], permissions };
}
export async function installationOctokit(
	installationId: number,
	repository: string,
	scope: 'review' | 'read' = 'review',
): Promise<Octokit> {
	const options = installationTokenOptions(installationId, repository, scope);
	const appId = process.env.GITHUB_APP_ID,
		key = process.env.GITHUB_PRIVATE_KEY;
	if (!appId || !key) throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required');
	const api = new Octokit({ auth: appJwt(appId, key) });
	const { data } = await api.apps.createInstallationAccessToken(options);
	return new Octokit({ auth: data.token });
}
