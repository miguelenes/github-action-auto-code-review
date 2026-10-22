import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { reserveReviewRound, finishReviewRound, attachFixCommit } from './state.js';
function fakeApi(){
 let head:string|undefined,sequence=0;const blobs=new Map<string,string>(),trees=new Map<string,string>(),commits=new Map<string,{tree:{sha:string};parents:string[]}>,refs=new Map<string,string>();
 const api={git:{
  async getRef(){if(!head)throw Object.assign(new Error('missing'),{status:404});return {data:{object:{sha:head}}}},
  async createBlob({content}:{content:string}){const sha='b'+(++sequence);blobs.set(sha,content);return {data:{sha}}},
  async createTree({tree}:{tree:{sha:string}[]}){const sha='t'+(++sequence);trees.set(sha,tree[0]!.sha);return {data:{sha}}},
  async createCommit({tree,parents}:{tree:{sha:string};parents:string[]}){const sha='c'+(++sequence);commits.set(sha,{tree:{sha:tree as unknown as string},parents});return {data:{sha}}},
  async createRef({sha}:{sha:string}){if(head)throw Object.assign(new Error('exists'),{status:422});head=sha;return {data:{}}},
  async updateRef({sha,force}:{sha:string;force:boolean}){const c=commits.get(sha);if(!c||(!force&&c.parents[0]!==head))throw Object.assign(new Error('conflict'),{status:422});head=sha;return {data:{}}},
  async getCommit({commit_sha}:{commit_sha:string}){const c=commits.get(commit_sha);if(!c)throw Object.assign(new Error('missing'),{status:404});return {data:{tree:c.tree}}},
  async getTree({tree_sha}:{tree_sha:string}){const blob=trees.get(tree_sha);return {data:{tree:blob?[{path:'journal.json',sha:blob}]:[]}}},
  async getBlob({file_sha}:{file_sha:string}){return {data:{content:Buffer.from(blobs.get(file_sha)??'').toString('base64'),encoding:'base64'}}}
 }};
 return api as unknown as Octokit;
}
test('review journal claims each new head once and enforces five PR rounds',async()=>{const api=fakeApi();const first=await reserveReviewRound(api,'o','r',7,'a');assert.deepEqual(first,{round:1,execute:true});const duplicate=await reserveReviewRound(api,'o','r',7,'a');assert.deepEqual(duplicate,{round:1,execute:false});const next=await reserveReviewRound(api,'o','r',7,'b');assert.deepEqual(next,{round:2,execute:true});await finishReviewRound(api,'o','r',7,'a','complete');await reserveReviewRound(api,'o','r',7,'c');await reserveReviewRound(api,'o','r',7,'d');const fifth=await reserveReviewRound(api,'o','r',7,'e');assert.deepEqual(fifth,{round:5,execute:true});const resumed=await reserveReviewRound(api,'o','r',7,'e',8,60*60*1000,true);assert.deepEqual(resumed,{round:5,execute:true});await assert.rejects(reserveReviewRound(api,'o','r',7,'f'),/five review rounds exhausted/)});
test('bot fix commit is bound to its existing review round',async()=>{const api=fakeApi();await reserveReviewRound(api,'o','r',7,'review-sha');await attachFixCommit(api,'o','r',7,'review-sha','bot-fix-sha');assert.deepEqual(await reserveReviewRound(api,'o','r',7,'bot-fix-sha'),{round:1,execute:false});await finishReviewRound(api,'o','r',7,'review-sha','complete');assert.deepEqual(await reserveReviewRound(api,'o','r',7,'bot-fix-sha'),{round:1,execute:false})});
