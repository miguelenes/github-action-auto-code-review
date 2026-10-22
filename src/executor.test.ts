import test from 'node:test';
import assert from 'node:assert/strict';
import { enableNativeAutoMerge } from './executor.js';

function githubApi(headSha:string) {
  const requests: unknown[]=[];
  const api={
    pulls:{get:async()=>({data:{head:{sha:headSha},node_id:'PR_node'}})},
    request:async(_route:string,params:unknown)=>{requests.push(params);return {data:{enablePullRequestAutoMerge:{pullRequest:{autoMergeRequest:{enabledAt:'2026-10-22T12:00:00Z'}}}}};}
  };
  return {api:api as never,requests};
}

test('native auto-merge is bound to the exact validated head',async()=>{
  const {api,requests}=githubApi('fixed-sha');
  await enableNativeAutoMerge(api,{owner:'owner',repo:'repo',pr:7,sha:'fixed-sha'},'SQUASH');
  assert.equal(requests.length,1);
  assert.deepEqual((requests[0] as {variables:{id:string;method:string}}).variables,{id:'PR_node',method:'SQUASH'});
});

test('native auto-merge refuses a head that changed after validation',async()=>{
  const {api,requests}=githubApi('newer-sha');
  await assert.rejects(enableNativeAutoMerge(api,{owner:'owner',repo:'repo',pr:7,sha:'validated-sha'},'SQUASH'),/head changed/);
  assert.equal(requests.length,0);
});
