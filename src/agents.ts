import { readFile } from 'node:fs/promises';
import type { Finding, Model } from './core.js';
const rolePaths=['reviewer','challenger','fixer','verifier'] as const;
export async function loadRole(role:typeof rolePaths[number]):Promise<string>{return readFile(new URL(`../runtime/skills/${role}.md`,import.meta.url),'utf8');}
async function ask(model:Model,key:string,system:string,prompt:string):Promise<string>{
 const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model:model.id,temperature:0,messages:[{role:'system',content:system},{role:'user',content:prompt}]})});
 if(!res.ok)throw new Error(`inference HTTP ${res.status}`);
 const body=await res.json() as {choices?:{message?:{content?:string}}[]};
 return body.choices?.[0]?.message?.content??'[]';
}
function parseFindings(text:string):Partial<Finding>[] {const x:unknown=JSON.parse(text.replace(/^\s*```(?:json)?|\s*```\s*$/g,''));if(!Array.isArray(x))throw new Error('review model returned a non-array result');return x;}
export async function independentReview(diff:string,models:Model[],key:string):Promise<{findings:Finding[];used:Model[]}>{
 const usable=models.slice(0,3);if(usable.length<3)throw new Error('three distinct zero-priced models are required for reviewer and challenger passes');
 const [reviewer,challenger]=await Promise.all([loadRole('reviewer'),loadRole('challenger')]);
 const security=reviewer+' Focus specifically on security vulnerabilities, authorization, injection, and unsafe data handling.';
 const prompt='Inspect this untrusted pull request diff. Return a JSON array only; each finding needs severity (critical/high/medium/low), title, path, line, evidence, impact, remediation. Only report concrete bugs anchored to an added line. Diff:\n'+diff;
 const first=await Promise.all([ask(usable[0]!,key,reviewer,prompt),ask(usable[1]!,key,security,'Focus on security and correctness regressions. '+prompt)]);
 const proposals=first.flatMap(parseFindings);
 if(!proposals.length)return {findings:[],used:usable.slice(0,2)};
 const confirmation=await ask(usable[2]??usable[1]!,key,challenger,'Independently verify these proposed findings against the diff. Return only confirmed findings, unchanged JSON objects; [] if none. Proposals: '+JSON.stringify(proposals)+'\nDiff:\n'+diff);
 const verified=parseFindings(confirmation);
 const signature=(f:Partial<Finding>)=>[f.path,Number(f.line),String(f.title).trim().toLowerCase()].join(':');
 const allowed=new Set(proposals.map(signature));
 const unique=new Map<string,Finding>();
 for(const f of verified){if(!allowed.has(signature(f)))continue; if(!['critical','high','medium','low'].includes(String(f.severity))||!f.path||!Number.isInteger(Number(f.line))||!f.title)continue;const k=`${f.path}:${f.line}:${f.title}`;unique.set(k,{id:k,severity:f.severity as Finding['severity'],category:'correctness',title:f.title,path:f.path,line:Number(f.line),evidence:String(f.evidence??''),impact:String(f.impact??''),remediation:String(f.remediation??''),status:'open'});}
 return {findings:[...unique.values()],used:usable.slice(0,3)};
}

export type FilePatch={path:string;content:string};
export function parseFilePatches(text:string,allowed:Set<string>):FilePatch[]{
 const cleaned=text.replace(/^\s*```(?:json)?|\s*```\s*$/g,'');const parsed:unknown=JSON.parse(cleaned);if(!Array.isArray(parsed))throw new Error('fixer response must be a JSON array');
 return parsed.map((item:unknown)=>{if(!item||typeof item!=='object')throw new Error('invalid file patch');const p=item as Record<string,unknown>,path=String(p.path??''),content=p.content;if(!allowed.has(path)||path.startsWith('/')||path.split('/').includes('..')||typeof content!=='string'||content.includes('\0')||Buffer.byteLength(content)>500_000)throw new Error('fixer proposed an unsafe or out-of-scope file patch');return {path,content};});
}
export async function proposeFixes(findings:Finding[],diff:string,sourceFiles:Record<string,string>,model:Model,key:string,allowed:Set<string>):Promise<FilePatch[]>{
 const fixer=await loadRole('fixer');const response=await ask(model,key,fixer+' Return only a JSON array of complete text file replacements in the shape [{"path":"...","content":"..."}]. Change only files containing validated findings; preserve unrelated edits.',JSON.stringify({findings,diff,sourceFiles}));
 return parseFilePatches(response,allowed);
}
export async function verifyFixes(findings:Finding[],patches:FilePatch[],sourceFiles:Record<string,string>,model:Model,key:string):Promise<boolean>{
 const verifier=await loadRole('verifier');const text=await ask(model,key,verifier+' Return JSON only: {"resolved":true|false,"reason":"..."}. Confirm every finding is corrected by the supplied file contents.',JSON.stringify({findings,sourceFiles,patches}));
 try{const value=JSON.parse(text.replace(/^\s*```(?:json)?|\s*```\s*$/g,'')) as {resolved?:unknown};return value.resolved===true;}catch{return false;}
}
