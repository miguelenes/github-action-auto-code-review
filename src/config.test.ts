import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewConfigSchema } from './config.js';
test('policy defaults never enable repository writes or auto-merge',()=>{const config=ReviewConfigSchema.parse({});assert.equal(config.autoMerge,false);assert.equal(config.automaticFixes,false);assert.equal(config.mode,'actions')});
test('policy rejects unlisted fields and malformed repository allowlists',()=>{assert.throws(()=>ReviewConfigSchema.parse({autoMerge:true,secret:'bad'}));assert.throws(()=>ReviewConfigSchema.parse({allowedRepositories:['owner']}))});
