import type { Octokit } from '@octokit/rest';
import type { FilePatch } from './agents.js';
import { defaultValidationCommands } from './config.js';
type Target={owner:string;repo:string;pr:number;sha:string};
export async function applyPatches(api:Octokit,target:Target,patches:FilePatch[],beforeUpdate?:(commitSha:string)=>Promise<void>):Promise<string>{
 if(!patches.length)throw new Error('no fixes were proposed');
 const {data:pr}=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});
 if(pr.head.sha!==target.sha)throw new Error('PR head changed before fix application');
 if(pr.head.repo?.full_name?.toLowerCase()!==`${target.owner}/${target.repo}`.toLowerCase())throw new Error('automatic branch writes are disabled for fork PRs');
 if(!pr.head.ref||pr.head.ref.startsWith('-'))throw new Error('unsafe PR branch ref');
 const files=await api.paginate(api.pulls.listFiles,{owner:target.owner,repo:target.repo,pull_number:target.pr,per_page:100});
 const allowed=new Set(files.map(f=>f.filename));
 if(patches.some(p=>!allowed.has(p.path)))throw new Error('fixer patch includes a file outside the pull request diff');
 const {data:commit}=await api.git.getCommit({owner:target.owner,repo:target.repo,commit_sha:target.sha});
 const listing=await api.git.getTree({owner:target.owner,repo:target.repo,tree_sha:commit.tree.sha,recursive:'true'});if(listing.data.truncated)throw new Error('source tree is too large to safely apply patches');const modes=new Map(listing.data.tree.map(t=>[t.path,t.mode]));
 const blobs=await Promise.all(patches.map(async p=>{const mode=modes.get(p.path);if(mode!=='100644'&&mode!=='100755')throw new Error('patch target is not a regular text file');return {path:p.path,mode:mode as '100644'|'100755',type:'blob' as const,sha:(await api.git.createBlob({owner:target.owner,repo:target.repo,content:p.content,encoding:'utf-8'})).data.sha};}));
 const tree=await api.git.createTree({owner:target.owner,repo:target.repo,base_tree:commit.tree.sha,tree:blobs});
 const newCommit=await api.git.createCommit({owner:target.owner,repo:target.repo,message:'Apply verified automated review fixes',tree:tree.data.sha,parents:[target.sha]});
 await beforeUpdate?.(newCommit.data.sha);
 const current=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});if(current.data.head.sha!==target.sha)throw new Error('PR head changed before branch update');
 await api.git.updateRef({owner:target.owner,repo:target.repo,ref:`heads/${pr.head.ref}`,sha:newCommit.data.sha,force:false});
 return newCommit.data.sha;
}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function validateCommit(api:Octokit,target:Target,headSha:string,timeoutMs=300_000,workflow='validate-review.yml',commands:readonly string[]=defaultValidationCommands):Promise<{passed:boolean;runUrl?:string}>{
 const {data:pr}=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});
 await api.actions.createWorkflowDispatch({owner:target.owner,repo:target.repo,workflow_id:workflow,ref:pr.base.ref,inputs:{pull_number:String(target.pr),head_sha:headSha,base_ref:pr.base.ref,validation_commands:commands.join('\n')}});
 const title=`Validate PR ${target.pr} @ ${headSha}`,deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  const runs=await api.actions.listWorkflowRuns({owner:target.owner,repo:target.repo,workflow_id:workflow,event:'workflow_dispatch',per_page:100});
  const run=runs.data.workflow_runs.find(r=>r.display_title===title);
  if(run?.status==='completed')return {passed:run.conclusion==='success',runUrl:run.html_url};
  await pause(5000);
 }
 throw new Error('isolated validation workflow timed out');
}

export async function enableNativeAutoMerge(api:Octokit,target:Target,method:'MERGE'|'SQUASH'|'REBASE'):Promise<void>{
 const {data:pr}=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});
 if(pr.head.sha!==target.sha)throw new Error('PR head changed before enabling auto-merge');
 const result=await api.request('POST /graphql',{query:'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { autoMergeRequest { enabledAt } } } }',variables:{id:pr.node_id,method}}) as {data?:{enablePullRequestAutoMerge?:{pullRequest?:{autoMergeRequest?:{enabledAt?:string|null}}}};errors?:unknown[]};
 if(result.errors?.length||!result.data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest)throw new Error('GitHub did not enable native pull request auto-merge');
}
