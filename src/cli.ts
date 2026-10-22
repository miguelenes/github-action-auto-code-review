import { providers } from './core.js';
import { discoverAll } from './providers.js';
import { Octokit } from '@octokit/rest';
import { installationOctokit } from './github.js';
import { reviewPullRequest } from './review.js';
import { reserveReviewRound, finishReviewRound } from './state.js';
const [command,...args]=process.argv.slice(2);
async function main(){
 if(command==='check') { console.log(JSON.stringify({ok:true,node:process.versions.node,providers})); return; }
 if(command==='discover') { const result=await discoverAll();console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([provider,value])=>[provider,{eligible:value.models.filter(m=>m.inputUsdPerMillion===0&&m.outputUsdPerMillion===0),catalogCount:value.models.length,...(value.error?{error:value.error}:{})}])),null,2));return; }
 if(command==='review'){
  const repo=args[args.indexOf('--repo')+1],pr=Number(args[args.indexOf('--pr')+1]);
  if(!repo||!Number.isInteger(pr)||pr<1)throw new Error('Usage: review --repo OWNER/NAME --pr NUMBER');
  const [owner,name]=repo.split('/');let api:Octokit;
  const installation=process.env.GITHUB_INSTALLATION_ID;
  if(installation)api=await installationOctokit(Number(installation));
  else if(process.env.GH_TOKEN)api=new Octokit({auth:process.env.GH_TOKEN});
  else throw new Error('Set GH_TOKEN or GitHub App credentials');
  const {data}=await api.pulls.get({owner,repo:name,pull_number:pr});
  const round=await reserveReviewRound(api,owner,name,pr,data.head.sha);
  try{const result=await reviewPullRequest(api,{owner,repo:name,pr,sha:data.head.sha});await finishReviewRound(api,owner,name,pr,data.head.sha,'complete');console.log(JSON.stringify({...result,round},null,2));}
  catch(e){await finishReviewRound(api,owner,name,pr,data.head.sha,'needs-human');throw e;}return;
 }
 if(command==='serve'){await import('./server.js');return;}
 console.log('review-app <check|discover|review --repo OWNER/NAME --pr NUMBER|serve>');
}
main().catch(e=>{console.error(e instanceof Error?e.message:'operation failed');process.exitCode=1;});
