import type { Octokit } from '@octokit/rest';
import { CatalogAdapter } from './providers.js';
import { independentReview, proposeFixes, verifyFixes } from './agents.js';
import { applyPatches, validateCommit, enableNativeAutoMerge } from './executor.js';
import { loadTrustedConfig } from './config.js';
import { attachFixCommit } from './state.js';
import { eligible, type Finding, type Model } from './core.js';
type Repo={owner:string;repo:string;pr:number;sha:string};
type ExecutionMode='hosted'|'actions';
function objectText(x:unknown):string { return typeof x==='string'?x:JSON.stringify(x); }
export function addedLines(diff:string):Map<string,Set<number>>{
 const out=new Map<string,Set<number>>();let path='',line=0;
 for(const row of diff.split('\n')){
  if(row.startsWith('+++ b/')){path=row.slice(6);continue;}
  const h=row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if(h){line=Number(h[1]);continue;}
  if(!path||row.startsWith('\\'))continue;
  if(row.startsWith('+')){const set=out.get(path)??new Set<number>();set.add(line);out.set(path,set);line++;}
  else if(row.startsWith(' '))line++;
 }
 return out;
}
export function anchorFindings(findings:Finding[],anchors:Map<string,Set<number>>):{valid:Finding[];rejected:number}{
 const valid=findings.filter(f=>anchors.get(f.path)?.has(f.line));
 return {valid,rejected:findings.length-valid.length};
}
export async function reviewPullRequest(api:Octokit,target:Repo,mode:ExecutionMode='actions'):Promise<{model:string;findings:Finding[];resolved:boolean}>{
 const {data:pr}=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});
 if(pr.head.sha!==target.sha)throw new Error('stale pull request head');
 const policy=await loadTrustedConfig(api,target.owner,target.repo,pr.base.sha);
 if(policy.mode!==mode)throw new Error('configured execution mode does not match this review adapter');
 if(!policy.providers.includes('openrouter'))throw new Error('OpenRouter inference is disabled by trusted base policy');
 if(policy.allowedRepositories.length&&!policy.allowedRepositories.includes(`${target.owner}/${target.repo}`))throw new Error('repository is not enabled by trusted base policy');
 const patch=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr,mediaType:{format:'diff'}});
 const diff=objectText(patch.data);
 if(diff.length>100000)throw new Error('pull request diff exceeds the 100 KB evidence limit; review marked incomplete');
 const anchors=addedLines(diff);
 const adapter=new CatalogAdapter('openrouter');
 const models=(await adapter.discover()).filter(m=>eligible(m)&&(!m.trialExpiresAt||new Date(m.trialExpiresAt)>new Date()));
 const candidates=models.filter(m=>m.id.endsWith(':free')).sort((a,b)=>Number(policy.preferredModels.includes(b.id))-Number(policy.preferredModels.includes(a.id)));
 if(candidates.length<3)throw new Error('at least three zero-priced OpenRouter models are required for independent review; paid fallback is disabled');
 const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error('OPENROUTER_API_KEY is required');
 const {findings,used}=await independentReview(diff,candidates,key);
 const {valid,rejected}=anchorFindings(findings,anchors);
 const fresh=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});if(fresh.data.head.sha!==target.sha)throw new Error('head changed during review');
 let resolved=valid.length===0&&rejected===0;
 const disclosure=`Independent review by ${used.map(m=>m.id).join(', ')} (catalog reports $0 input and output pricing).`;
 if(valid.length){
  await api.pulls.createReview({owner:target.owner,repo:target.repo,pull_number:target.pr,commit_id:target.sha,event:'REQUEST_CHANGES',body:disclosure,comments:valid.slice(0,100).map(f=>({path:f.path,line:f.line,side:'RIGHT' as const,body:`**${f.severity.toUpperCase()} — ${f.title}**\n\n${f.impact}\n\nSuggested remediation: ${f.remediation}\n\nEvidence: ${f.evidence}`}))});
  if(valid.length>100){const remainder=valid.slice(100).map(f=>`- ${f.severity.toUpperCase()} ${f.path}:${f.line}: ${f.title} — ${f.impact}`).join('\n');await api.issues.createComment({owner:target.owner,repo:target.repo,issue_number:target.pr,body:`Additional verified findings omitted from inline review due to GitHub's comment limit:\n${remainder}`});}
 }else if(rejected){await api.issues.createComment({owner:target.owner,repo:target.repo,issue_number:target.pr,body:`${disclosure}\n\nReview coverage is incomplete: ${rejected} proposed finding(s) could not be anchored to added lines. A maintainer must assess this result; auto-merge is blocked.`});}
 else {await api.issues.createComment({owner:target.owner,repo:target.repo,issue_number:target.pr,body:`${disclosure}\n\nNo actionable findings were confirmed. This is not a verified clean bill of health.`});if(policy.autoMerge){const checks=await validateCommit(api,target,target.sha,policy.validationTimeoutSeconds*1000,policy.validationWorkflow,policy.validationCommands);if(!checks.passed)throw new Error('auto-merge blocked because isolated validation failed');await enableNativeAutoMerge(api,target,policy.mergeMethod);resolved=true;}}
 if(valid.length&&policy.automaticFixes){
  try{
   const fixer=candidates[3]??used[1]!;const sourceFiles:Record<string,string>={};for(const path of new Set(valid.map(f=>f.path))){const file=await api.repos.getContent({owner:target.owner,repo:target.repo,path,ref:target.sha});if(Array.isArray(file.data)||file.data.type!=='file'||file.data.encoding!=='base64')throw new Error('finding source is not an ordinary text file');const content=Buffer.from(file.data.content,'base64').toString('utf8');if(content.includes('\0')||Buffer.byteLength(content)>500_000)throw new Error('finding source cannot be safely patched');sourceFiles[path]=content;}const patches=await proposeFixes(valid,diff,sourceFiles,fixer,key,new Set(Object.keys(sourceFiles)));
   const headRepo=pr.head.repo?.full_name?.toLowerCase(),sameRepo=headRepo===`${target.owner}/${target.repo}`.toLowerCase();
   if(!sameRepo)throw new Error('fork PR fixes require maintainer authorization and are not applied automatically');
   const fixSha=await applyPatches(api,target,patches,sha=>attachFixCommit(api,target.owner,target.repo,target.pr,target.sha,sha));
   const checks=await validateCommit(api,target,fixSha,policy.validationTimeoutSeconds*1000,policy.validationWorkflow,policy.validationCommands);
   const latest=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});if(latest.data.head.sha!==fixSha)throw new Error('PR head changed during validation');
   const verifier=candidates[4]??used[0]!;const verified=checks.passed&&await verifyFixes(valid,patches,sourceFiles,verifier,key);
   const latestDiff=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr,mediaType:{format:'diff'}});const finalReview=await independentReview(objectText(latestDiff.data),candidates,key);
   resolved=rejected===0&&checks.passed&&verified&&finalReview.findings.length===0;if(resolved&&policy.autoMerge)await enableNativeAutoMerge(api,{...target,sha:fixSha},policy.mergeMethod);
   await api.issues.createComment({owner:target.owner,repo:target.repo,issue_number:target.pr,body:`Automated fix commit: ${fixSha}. Isolated validation: ${checks.passed?'passed':'failed'}${checks.runUrl?` ([run](${checks.runUrl}))`:''}. Independent fix verification: ${verified?'passed':'failed'}.`});
  }catch(e){const message=e instanceof Error?e.message:'fix attempt failed';await api.issues.createComment({owner:target.owner,repo:target.repo,issue_number:target.pr,body:`Automated fix attempt stopped for safety: ${message}. The inline findings remain open for a maintainer.`});}
 }
 return {model:used.map(m=>m.id).join(', '),findings:valid,resolved};
}
