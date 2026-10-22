import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, nextRound, mergeReady, type Model, type ReviewRound } from './core.js';
const model=(price:number|null):Model=>({provider:'openrouter',id:'example',inputUsdPerMillion:price,outputUsdPerMillion:price,usageTerms:'free tier',observedAt:new Date().toISOString(),sourceUrl:'https://example.com'});
test('eligibility requires known zero prices',()=>{assert.equal(eligible(model(0)),true);assert.equal(eligible(model(null)),false);assert.equal(eligible(model(1)),false)});
test('round budget terminates at five',()=>{let r:ReviewRound={pr:1,headSha:'abc',round:5,phase:'needs-human',coverage:'incomplete',findings:[],models:[]};assert.throws(()=>nextRound(r,'def'),/exhausted/)});
test('merge readiness needs all findings fixed and complete checks',()=>{let r:ReviewRound={pr:1,headSha:'abc',round:1,phase:'complete',coverage:'complete',findings:[],models:[]};assert.equal(mergeReady(r,true),true);r.coverage='incomplete';assert.equal(mergeReady(r,true),false)});
