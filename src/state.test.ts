import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { reserveReviewRound, finishReviewRound } from './state.js';
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
test('review journal reserves atomically and enforces five PR rounds',async()=>{const api=fakeApi();const rounds=await Promise.all([reserveReviewRound(api,'o','r',7,'a'),reserveReviewRound(api,'o','r',7,'b')]);assert.deepEqual(rounds.sort(),[1,2]);await finishReviewRound(api,'o','r',7,'a','complete');await reserveReviewRound(api,'o','r',7,'c');await reserveReviewRound(api,'o','r',7,'d');await reserveReviewRound(api,'o','r',7,'e');await assert.rejects(reserveReviewRound(api,'o','r',7,'f'),/five review rounds exhausted/)});
