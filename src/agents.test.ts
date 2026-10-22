import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFilePatches } from './agents.js';
test('fix proposals are constrained to validated source paths',()=>{const allowed=new Set(['src/a.ts']);assert.deepEqual(parseFilePatches('[{"path":"src/a.ts","content":"fixed"}]',allowed),[{path:'src/a.ts',content:'fixed'}]);assert.throws(()=>parseFilePatches('[{"path":"../secret","content":"x"}]',allowed));assert.throws(()=>parseFilePatches('[{"path":"src/a.ts","content":"x"}]',new Set()))});
test('fix proposals reject binary and oversized payloads',()=>{assert.throws(()=>parseFilePatches('[{"path":"a","content":"\\u0000"}]',new Set(['a'])));assert.throws(()=>parseFilePatches(JSON.stringify([{path:'a',content:'x'.repeat(500001)}]),new Set(['a'])))});
