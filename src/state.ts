import type { Octokit } from '@octokit/rest';
export type JournalEntry={pr:number;sha:string;round:number;status:'started'|'complete'|'needs-human';at:string;leaseUntil?:string;fixShas?:string[]};
type Journal={version:1;entries:JournalEntry[]};
const branch='agent-review-state', ref='refs/heads/'+branch, file='journal.json';
const empty:Journal={version:1,entries:[]};
async function read(api:Octokit,owner:string,repo:string):Promise<{sha:string;journal:Journal}|undefined>{
 try{
  const {data:r}=await api.git.getRef({owner,repo,ref:'heads/'+branch});
  const commit=await api.git.getCommit({owner,repo,commit_sha:r.object.sha});
  const tree=await api.git.getTree({owner,repo,tree_sha:commit.data.tree.sha});
  const item=tree.data.tree.find(x=>x.path===file);
  if(!item?.sha)return {sha:r.object.sha,journal:empty};
  const blob=await api.git.getBlob({owner,repo,file_sha:item.sha});
  const value=JSON.parse(Buffer.from(blob.data.content,'base64').toString()) as Journal;
  if(value.version!==1||!Array.isArray(value.entries))throw new Error('invalid review state journal');
  return {sha:r.object.sha,journal:value};
 }catch(e){if((e as {status?:number}).status===404)return undefined;throw e;}
}
async function write(api:Octokit,owner:string,repo:string,prior:{sha:string;journal:Journal}|undefined,journal:Journal):Promise<void>{
 const blob=await api.git.createBlob({owner,repo,content:JSON.stringify(journal),encoding:'utf-8'});
 const tree=await api.git.createTree({owner,repo,tree:[{path:file,mode:'100644',type:'blob',sha:blob.data.sha}]});
 const commit=await api.git.createCommit({owner,repo,message:'Update review round journal',tree:tree.data.sha,parents:prior?[prior.sha]:[]});
 if(prior)await api.git.updateRef({owner,repo,ref:'heads/'+branch,sha:commit.data.sha,force:false});
 else await api.git.createRef({owner,repo,ref,sha:commit.data.sha});
}
export async function reserveReviewRound(api:Octokit,owner:string,repo:string,pr:number,sha:string,maxRetries=8,leaseMs=60*60*1000,forceResume=false):Promise<{round:number;execute:boolean}>{
 for(let attempt=0;attempt<maxRetries;attempt++){
  const prior=await read(api,owner,repo), entries=prior?.journal.entries??[];
  const prEntries=entries.filter(e=>e.pr===pr);
  const existing=prEntries.find(e=>e.sha===sha||e.fixShas?.includes(sha));
  if(existing&&existing.sha!==sha)return {round:existing.round,execute:false};
  if(existing&&existing.status!=='started')return {round:existing.round,execute:false};
  const now=Date.now();
  if(!forceResume&&existing?.leaseUntil&&Date.parse(existing.leaseUntil)>now)return {round:existing.round,execute:false};
  const rounds=prEntries.length;
  if(!existing&&rounds>=5)throw new Error('five review rounds exhausted; needs-human');
  const round=existing?.round??rounds+1,leaseUntil=new Date(now+leaseMs).toISOString();
  const nextEntry:JournalEntry={pr,sha,round,status:'started',at:new Date(now).toISOString(),leaseUntil};
  const nextEntries=existing?entries.map(e=>e.pr===pr&&e.sha===sha?nextEntry:e):[...entries,nextEntry];
  const journal:Journal={version:1,entries:nextEntries};
  try{await write(api,owner,repo,prior,journal);return {round,execute:true};}
  catch(e){const status=(e as {status?:number}).status;if(status===409||status===422)continue;throw e;}
 }
 throw new Error('could not reserve review round after concurrent state updates');
}
export async function attachFixCommit(api:Octokit,owner:string,repo:string,pr:number,reviewSha:string,fixSha:string,maxRetries=8):Promise<void>{
 for(let attempt=0;attempt<maxRetries;attempt++){
  const prior=await read(api,owner,repo);if(!prior)throw new Error('review journal missing');
  const entries=[...prior.journal.entries],idx=entries.findIndex(e=>e.pr===pr&&e.sha===reviewSha&&e.status==='started');
  if(idx<0)throw new Error('active review round reservation missing');
  const entry=entries[idx]!,fixShas=[...new Set([...(entry.fixShas??[]),fixSha])];
  entries[idx]={...entry,fixShas,at:new Date().toISOString()};
  try{await write(api,owner,repo,prior,{version:1,entries});return;}
  catch(e){const code=(e as {status?:number}).status;if(code===409||code===422)continue;throw e;}
 }
 throw new Error('could not bind fix commit to its review round');
}
export async function finishReviewRound(api:Octokit,owner:string,repo:string,pr:number,sha:string,status:'complete'|'needs-human',maxRetries=8):Promise<void>{
 for(let attempt=0;attempt<maxRetries;attempt++){
  const prior=await read(api,owner,repo);if(!prior)throw new Error('review journal missing');
  const entries=[...prior.journal.entries],idx=entries.map(e=>e.pr===pr&&e.sha===sha).lastIndexOf(true);
  if(idx<0)throw new Error('review round reservation missing');
  entries[idx]={...entries[idx]!,status,at:new Date().toISOString(),leaseUntil:undefined};
  try{await write(api,owner,repo,prior,{version:1,entries});return;}
  catch(e){const code=(e as {status?:number}).status;if(code===409||code===422)continue;throw e;}
 }
 throw new Error('could not finalize review state after concurrent updates');
}
