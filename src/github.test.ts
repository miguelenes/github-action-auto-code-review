import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature } from './github.js';
test('webhook signature verification rejects tampering',()=>{const body=Buffer.from('{"action":"opened"}'),secret='fixture-secret';const sig='sha256='+createHmac('sha256',secret).update(body).digest('hex');assert.equal(verifySignature(secret,body,sig),true);assert.equal(verifySignature(secret,Buffer.from('{}'),sig),false);assert.equal(verifySignature(secret,body,undefined),false)});
