import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogAdapter } from './providers.js';
test('OpenRouter model prices normalize from per-token to per-million',async()=>{
 const adapter=new CatalogAdapter('openrouter');
 const models=await adapter.discover(async()=>new Response(JSON.stringify({data:[{id:'example:free',context_length:4096,pricing:{prompt:'0',completion:'0'}},{id:'paid',pricing:{prompt:'0.000001',completion:'0.000002'}}]}),{status:200}));
 assert.equal(models.length,2);assert.equal(models[0]?.inputUsdPerMillion,0);assert.equal(models[1]?.inputUsdPerMillion,1);
});
test('catalog HTTP failures are reported',async()=>{const adapter=new CatalogAdapter('openrouter');await assert.rejects(adapter.discover(async()=>new Response('',{status:429})),/HTTP 429/)});
test('missing cost remains unknown, not free',async()=>{const adapter=new CatalogAdapter('openrouter');const [m]=await adapter.discover(async()=>new Response(JSON.stringify({data:[{id:'unknown'}]}),{status:200}));assert.equal(m?.inputUsdPerMillion,null)});
