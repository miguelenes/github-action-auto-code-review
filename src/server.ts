import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { verifySignature, installationOctokit } from './github.js';
import { reviewPullRequest } from './review.js';
import { reserveReviewRound, finishReviewRound } from './state.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
const dbPath=process.env.STATE_DB??'data/reviews.sqlite';
mkdirSync(join(dbPath,'..'),{recursive:true});
const db=new DatabaseSync(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS jobs(repository TEXT NOT NULL, pr INTEGER NOT NULL, sha TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(repository,pr,sha));`);
db.prepare("UPDATE jobs SET state='recovering',updated_at=? WHERE state='running'").run(new Date().toISOString());
const enqueue=db.prepare(`INSERT OR IGNORE INTO jobs(repository,pr,sha,round,state,updated_at) VALUES(?,?,?,0,'queued',?)`);
const setState=db.prepare('UPDATE jobs SET state=?,round=round+?,updated_at=? WHERE repository=? AND pr=? AND sha=?');
const pending=db.prepare("SELECT repository,pr,sha,state FROM jobs WHERE state IN('queued','recovering') LIMIT 1");
let working=false, ready=true;
async function drain(){
 if(working)return;working=true;
 try{for(;;){const row=pending.get() as {repository:string;pr:number;sha:string;state:'queued'|'recovering'}|undefined;if(!row)break;
 const [owner,repo]=row.repository.split('/');if(!owner||!repo){setState.run('failed',0,new Date().toISOString(),row.repository,row.pr,row.sha);continue;}
 const lock=db.prepare("UPDATE jobs SET state='running',updated_at=? WHERE repository=? AND pr=? AND sha=? AND state IN('queued','recovering')").run(new Date().toISOString(),row.repository,row.pr,row.sha);if(!lock.changes)continue;
 try{
  const id=Number(process.env.GITHUB_INSTALLATION_ID);if(!id)throw new Error('GITHUB_INSTALLATION_ID is required');
  const api=await installationOctokit(id);
  const current=await api.pulls.get({owner,repo,pull_number:row.pr});
  if(current.data.head.sha!==row.sha){setState.run('ignored',0,new Date().toISOString(),row.repository,row.pr,row.sha);continue;}
  const reservation=await reserveReviewRound(api,owner,repo,row.pr,row.sha,8,60*60*1000,row.state==='recovering');
  if(!reservation.execute){setState.run('ignored',0,new Date().toISOString(),row.repository,row.pr,row.sha);continue;}
  try{const result=await reviewPullRequest(api,{owner,repo,pr:row.pr,sha:row.sha},'hosted');await finishReviewRound(api,owner,repo,row.pr,row.sha,result.resolved?'complete':'needs-human');setState.run(result.resolved?'complete':'needs-human',1,new Date().toISOString(),row.repository,row.pr,row.sha);}
  catch(e){await finishReviewRound(api,owner,repo,row.pr,row.sha,'needs-human').catch(()=>{});throw e;}
 }catch{setState.run('needs-human',1,new Date().toISOString(),row.repository,row.pr,row.sha);}
 }}catch{ready=false;}finally{working=false;}
}
const server=createServer((req,res)=>{
 if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200).end('ok');return;}
 if(req.method==='GET'&&req.url==='/readyz'){const ok=ready&&Boolean(db.prepare('SELECT 1').get());res.writeHead(ok?200:503).end(ok?'ready':'not ready');return;}
 if(req.method!=='POST'||req.url!=='/webhook'){res.writeHead(404).end();return;}
 const chunks:Buffer[]=[];let size=0;
 req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024){res.writeHead(413).end();req.destroy();}else chunks.push(chunk);});
 req.on('end',()=>{const body=Buffer.concat(chunks),secret=process.env.GITHUB_WEBHOOK_SECRET;if(!secret||!verifySignature(secret,body,req.headers['x-hub-signature-256'])){res.writeHead(401).end();return;}
 try{const event=String(req.headers['x-github-event']??''),data=JSON.parse(body.toString());if(event==='pull_request'&&['opened','synchronize','reopened','ready_for_review'].includes(data.action)&&data.pull_request&&!data.pull_request.draft){const repository=data.repository.full_name,pr=Number(data.pull_request.number),sha=String(data.pull_request.head.sha);enqueue.run(repository,pr,sha,new Date().toISOString());res.writeHead(202).end('queued');void drain();return;}res.writeHead(202).end('ignored');}catch{res.writeHead(400).end();}});
});
server.listen(Number(process.env.PORT??3000),()=>console.log('webhook listener ready'));
