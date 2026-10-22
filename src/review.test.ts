import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, anchorFindings } from './review.js';
test('diff evidence only anchors added lines',()=>{const lines=addedLines('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n old\n+new\n same\n');assert.equal(lines.get('a.ts')?.has(2),true);assert.equal(lines.get('a.ts')?.has(1),false);assert.equal(lines.get('a.ts')?.has(3),false)});
test('unanchored proposed findings remain visible as incomplete coverage',()=>{const anchors=new Map([['a.ts',new Set([4])]]);const finding={id:'x',severity:'high' as const,category:'correctness',title:'Issue',path:'a.ts',line:3,evidence:'x',impact:'x',remediation:'x',status:'open' as const};assert.deepEqual(anchorFindings([finding],anchors),{valid:[],rejected:1})});
