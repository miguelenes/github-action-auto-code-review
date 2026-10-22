import { z } from 'zod';
export const Providers = ['openrouter','nvidia','groq','gemini','cerebras','mistral','github-models','cloudflare'] as const;
export type Provider = typeof Providers[number];
export const ModelSchema=z.object({provider:z.enum(Providers),id:z.string(),context:z.number().int().positive().optional(),inputUsdPerMillion:z.number().nonnegative().nullable(),outputUsdPerMillion:z.number().nonnegative().nullable(),trialExpiresAt:z.string().datetime().nullable().optional(),usageTerms:z.string(),observedAt:z.string().datetime(),sourceUrl:z.string().url()});
export type Model= z.infer<typeof ModelSchema>;
export type Finding={id:string,severity:'critical'|'high'|'medium'|'low'|'info',category:string,title:string,path:string,line:number,evidence:string,impact:string,remediation:string,status:'open'|'fixed'|'disputed'};
export type ReviewRound={pr:number,headSha:string,round:number,phase:'review'|'challenge'|'fix'|'verify'|'complete'|'needs-human',coverage:'complete'|'incomplete',findings:Finding[],models:{provider:Provider,id:string,reason:string}[]};
export interface ProviderAdapter {provider:Provider; discover():Promise<Model[]>; complete(model:string,prompt:string):Promise<string>}
export function eligible(m:Model,now=new Date()):boolean { if(m.inputUsdPerMillion===null||m.outputUsdPerMillion===null)return false; if(m.inputUsdPerMillion>0||m.outputUsdPerMillion>0)return false; if(m.trialExpiresAt&&new Date(m.trialExpiresAt)<=now)return false; return true; }
export function nextRound(previous:ReviewRound|undefined,headSha:string):number { if(!previous)return 1; if(previous.round>=5)throw new Error('five review rounds exhausted; needs-human'); if(previous.headSha===headSha&&previous.phase==='complete') return previous.round; return previous.round+1; }
export function mergeReady(r:ReviewRound,checksPass:boolean):boolean{return r.phase==='complete'&&r.coverage==='complete'&&checksPass&&r.findings.every(f=>f.status==='fixed');}
export const providers=Providers;
