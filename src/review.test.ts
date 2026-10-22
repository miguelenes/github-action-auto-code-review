import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLines } from './review.js';
test('diff evidence only anchors added lines',()=>{const lines=addedLines('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n old\n+new\n same\n');assert.equal(lines.get('a.ts')?.has(2),true);assert.equal(lines.get('a.ts')?.has(1),false);assert.equal(lines.get('a.ts')?.has(3),false)});
