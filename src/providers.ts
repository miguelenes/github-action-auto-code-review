import { ModelSchema, Providers, type Model, type Provider } from './core.js';

type Catalog = { url: string; key?: string; listPath?: string };
const catalogs: Record<Provider, Catalog> = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', listPath: 'data' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', key: 'NVIDIA_API_KEY', listPath: 'data' },
  groq: { url: 'https://api.groq.com/openai/v1/models', key: 'GROQ_API_KEY', listPath: 'data' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models', key: 'GEMINI_API_KEY', listPath: 'models' },
  cerebras: { url: 'https://api.cerebras.ai/v1/models', key: 'CEREBRAS_API_KEY', listPath: 'data' },
  mistral: { url: 'https://api.mistral.ai/v1/models', key: 'MISTRAL_API_KEY', listPath: 'data' },
  'github-models': { url: 'https://models.github.ai/catalog/models', key: 'GITHUB_TOKEN', listPath: 'models' },
  cloudflare: { url: process.env.CLOUDFLARE_ACCOUNT_ID ? 'https://api.cloudflare.com/client/v4/accounts/'+process.env.CLOUDFLARE_ACCOUNT_ID+'/ai/models/search' : '', key: 'CLOUDFLARE_API_TOKEN', listPath: 'result' },
};
const now = () => new Date().toISOString();
function atPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v,k) => v && typeof v === 'object' ? (v as Record<string,unknown>)[k] : undefined,value);
}
function price(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}
export class CatalogAdapter {
  constructor(readonly provider: Provider) {}
  async discover(fetcher: typeof fetch = fetch): Promise<Model[]> {
    const cfg=catalogs[this.provider], key=cfg.key ? process.env[cfg.key] : undefined;
    if(this.provider==='cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
    if(cfg.key && !key) return [];
    const headers:Record<string,string>={accept:'application/json'};
    if(key) headers.authorization=`Bearer ${key}`;
    if(this.provider==='gemini' && key) { headers['x-goog-api-key']=key; delete headers.authorization; }
    const res=await fetcher(cfg.url,{headers,signal:AbortSignal.timeout(12000)});
    if(!res.ok) throw new Error(`${this.provider} catalog HTTP ${res.status}`);
    const body:unknown=await res.json(), rows=atPath(body,cfg.listPath ?? 'data');
    if(!Array.isArray(rows)) throw new Error(`${this.provider} catalog response has no model list`);
    const observedAt=now();
    return rows.flatMap((row:unknown):Model[]=>{
      if(!row || typeof row!=='object') return [];
      const r=row as Record<string,unknown>, id=String(r.id ?? r.name ?? '');
      if(!id) return [];
      const p=(r.pricing && typeof r.pricing==='object'?r.pricing:{}) as Record<string,unknown>;
      const input=price(p.prompt ?? p.input ?? r.input_price), output=price(p.completion ?? p.output ?? r.output_price);
      const context=Number(r.context_length ?? r.contextWindow ?? r.inputTokenLimit);
      const trialExpiry=typeof r.trial_expires_at==='string'?r.trial_expires_at:null;
      const usageTerms=String(r.usage_terms ?? r.terms ?? (this.provider==='nvidia'?'NVIDIA API catalog trial access is evaluation-only; production eligibility unverified':'Provider terms not supplied by catalog'));
      const candidate={provider:this.provider,id,inputUsdPerMillion:input===null?null:input*1_000_000,outputUsdPerMillion:output===null?null:output*1_000_000,...(Number.isSafeInteger(context)&&context>0?{context}:{}),trialExpiresAt:trialExpiry,usageTerms,observedAt,sourceUrl:cfg.url};
      const parsed=ModelSchema.safeParse(candidate); return parsed.success?[parsed.data]:[];
    });
  }
}
export async function discoverAll(): Promise<Record<Provider,{models:Model[];error?:string}>> {
  const pairs=await Promise.all(Providers.map(async p=>{try{return [p,{models:await new CatalogAdapter(p).discover()}] as const;}catch(e){return [p,{models:[],error:e instanceof Error?e.message:'catalog failure'}] as const;}}));
  return Object.fromEntries(pairs);
}
