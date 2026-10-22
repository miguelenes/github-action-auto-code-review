import { z } from 'zod';
import { parse } from 'yaml';
import { Providers } from './core.js';
import type { Octokit } from '@octokit/rest';
export const defaultValidationCommands=Object.freeze(['pnpm --dir untrusted install --frozen-lockfile --ignore-scripts','pnpm --dir untrusted build','pnpm --dir untrusted test']);
export const ReviewConfigSchema=z.object({
 mode:z.enum(['hosted','actions']).default('actions'),
 providers:z.array(z.enum(Providers)).default(['openrouter']),
 preferredModels:z.array(z.string()).default([]),
 allowedRepositories:z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).default([]),
 automaticFixes:z.boolean().default(false),
 autoMerge:z.boolean().default(false),
 mergeMethod:z.enum(['MERGE','SQUASH','REBASE']).default('SQUASH'),
 validationWorkflow:z.string().default('validate-review.yml'),
 validationCommands:z.array(z.string().min(1).max(2000)).min(1).max(10).default([...defaultValidationCommands]),
 validationTimeoutSeconds:z.number().int().min(60).max(1800).default(300)
}).strict();
export type ReviewConfig=z.infer<typeof ReviewConfigSchema>;
export const defaultConfig=ReviewConfigSchema.parse({});
export async function loadTrustedConfig(api:Octokit,owner:string,repo:string,ref:string):Promise<ReviewConfig>{
 try{
  const result=await api.repos.getContent({owner,repo,path:'review-app.yml',ref});
  if(Array.isArray(result.data)||result.data.type!=='file'||result.data.encoding!=='base64')throw new Error('review-app.yml must be a regular text file');
  const source=Buffer.from(result.data.content,'base64').toString('utf8');
  return ReviewConfigSchema.parse(parse(source));
 }catch(e){if((e as {status?:number}).status===404)return defaultConfig;throw e;}
}
