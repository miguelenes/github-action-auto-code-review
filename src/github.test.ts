import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, installationTokenOptions } from './github.js';
test('webhook signature verification rejects tampering', () => {
	const body = Buffer.from('{"action":"opened"}'),
		secret = 'fixture-secret';
	const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
	assert.equal(verifySignature(secret, body, sig), true);
	assert.equal(verifySignature(secret, Buffer.from('{}'), sig), false);
	assert.equal(verifySignature(secret, body, undefined), false);
});
test('installation tokens are repository scoped and discovery tokens are read only', () => {
	assert.deepEqual(installationTokenOptions(17, 'owner/repo', 'read'), {
		installation_id: 17,
		repositories: ['owner/repo'],
		permissions: { contents: 'read' },
	});
	assert.deepEqual(installationTokenOptions(17, 'owner/repo', 'review'), {
		installation_id: 17,
		repositories: ['owner/repo'],
		permissions: { pull_requests: 'write', contents: 'write', issues: 'write', actions: 'write' },
	});
	assert.throws(() => installationTokenOptions(0, 'owner/repo'), /installation ID/);
	assert.throws(() => installationTokenOptions(17, '../repo'), /OWNER\/REPOSITORY/);
});
