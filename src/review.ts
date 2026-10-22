import type { Octokit } from '@octokit/rest';
import { CatalogAdapter } from './providers.js';
import { independentReview } from './agents.js';
import { eligible, type Finding, type Model } from './core.js';
type Repo={owner:string;repo:string;pr:number;sha:string};
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
export async function reviewPullRequest(api:Octokit,target:Repo):Promise<{model:string;findings:Finding[]}>{
 const {data:pr}=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});
 if(pr.head.sha!==target.sha)throw new Error('stale pull request head');
 const patch=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr,mediaType:{format:'diff'}});
 const diff=objectText(patch.data);
 if(diff.length>100000)throw new Error('pull request diff exceeds the 100 KB evidence limit; review marked incomplete');
 const anchors=addedLines(diff);
 const adapter=new CatalogAdapter('openrouter');
 const models=(await adapter.discover()).filter(m=>eligible(m)&&(!m.trialExpiresAt||new Date(m.trialExpiresAt)>new Date()));
 const candidates=models.filter(m=>m.id.endsWith(':free'));
 if(candidates.length<3)throw new Error('at least three zero-priced OpenRouter models are required for independent review; paid fallback is disabled');
 const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error('OPENROUTER_API_KEY is required');
 const {findings,used}=await independentReview(diff,candidates,key);
 const valid=findings.filter(f=>anchors.get(f.path)?.has(f.line));
 const fresh=await api.pulls.get({owner:target.owner,repo:target.repo,pull_number:target.pr});if(fresh.data.head.sha!==target.sha)throw new Error('head changed during review');
 const body=valid.length?valid.map(f=>`- **${f.severity.toUpperCase()}** ${f.path}:${f.line} — ${f.title}\n  ${f.impact}\n  ${f.remediation}`).join('\n'):'No actionable findings were returned. This is not a verified clean bill of health.';
 await api.issues.createComment({owner:target.owner,repo:target.repo,issue_number:target.pr,body:`Independent review by ${used.map(m=>m.id).join(', ')} (catalog reports $0 input and output pricing):\n\n${body}`});
 return {model:used.map(m=>m.id).join(', '),findings:valid};
}
