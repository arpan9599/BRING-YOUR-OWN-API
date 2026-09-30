import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../lib/server.ts';
import {encryptSecret,sha256,REFUSAL} from '../lib/grounding.mjs';
const OWNER='11111111-1111-4111-8111-111111111111',BOT='22222222-2222-4222-8222-222222222222',DOC='33333333-3333-4333-8333-333333333333';
const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'secret-test',CREDENTIAL_ENCRYPTION_KEY:key,APP_URL:'https://docbot.test'};
const authUser={id:OWNER,aud:'authenticated',role:'authenticated',email:'',created_at:'2026-01-01',app_metadata:{},user_metadata:{}};
const bot={id:BOT,owner_id:OWNER,telegram_username:'student_bot',telegram_bot_id:1234567,webhook_secret_sha256:await sha256('webhook-secret'),pending_webhook_secret_sha256:null,paired_chat_id:42,claim_sha256:null,status:'connected',nvidia_key_encrypted:await encryptSecret(key,'test-nvidia',OWNER),telegram_token_encrypted:await encryptSecret(key,'1234567:test-token',OWNER)};
function request(path,body,headers={}){return new Request('https://docbot.test'+path,{method:body?'POST':'GET',headers:{Origin:'https://docbot.test',Authorization:'Bearer user-session','Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});}
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
async function mocked(fn,run){const original=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=original;}}
test('unconfigured website exposes no credentials and rejects uploads',async()=>{
 const config=await(await handleApi(request('/api/config'),{})).json();assert.equal(config.configured,false);assert.equal(config.anonKey,null);
 const result=await handleApi(request('/api/documents/init',{title:'test'}),{});assert.equal(result.status,503);
});
test('browser writes require same origin and a verified Supabase session',async()=>{
 await mocked(()=>{throw new Error('Must not call external APIs');},async()=>{
  assert.equal((await handleApi(request('/api/chat',{question:'test'},{Origin:'https://attacker.test'}),env)).status,403);
  assert.equal((await handleApi(request('/api/state',null,{Authorization:''}),env)).status,401);
 });
});
test('forged owner IDs never control document deletion scope',async()=>{
 const calls=[];
 await mocked(async(input,init)=>{const url=new URL(input instanceof Request?input.url:input);calls.push({url,init});if(url.pathname==='/auth/v1/user')return json(authUser);if(url.pathname.endsWith('/bots'))return json(bot);if(url.pathname.endsWith('/documents'))return new Response(null,{status:204});throw new Error('Unexpected endpoint '+url.pathname);},async()=>{
  const res=await handleApi(request('/api/documents/delete',{id:DOC,owner_id:'forged-owner',bot_id:'forged-bot'}),env);assert.equal(res.status,200);
  const deletion=calls.find(c=>c.init.method==='DELETE');assert.equal(deletion.url.searchParams.get('owner_id'),'eq.'+OWNER);assert.equal(deletion.url.searchParams.get('bot_id'),'eq.'+BOT);assert.equal(deletion.url.searchParams.get('id'),'eq.'+DOC);
 });
});
test('forged webhook secrets cannot trigger AI or Telegram requests',async()=>{
 let calls=0;await mocked(async(input)=>{calls++;assert.ok(String(input).includes('/bots'));return json(bot);},async()=>{const result=await handleApi(request('/api/telegram/'+BOT,{update_id:1},{'X-Telegram-Bot-Api-Secret-Token':'wrong'}),env);assert.equal(result.status,403);assert.equal(calls,1);});
});
test('duplicate completed updates are acknowledged without regenerating answers',async()=>{
 const urls=[];await mocked(async(input)=>{const url=String(input);urls.push(url);if(url.includes('/bots'))return json(bot);if(url.includes('/claim_telegram_update'))return json({state:'done'});throw new Error('Unexpected side effect');},async()=>{const result=await handleApi(request('/api/telegram/'+BOT,{update_id:7,message:{chat:{id:42,type:'private'},text:'question'}},{'X-Telegram-Bot-Api-Secret-Token':'webhook-secret'}),env);assert.equal(result.status,200);assert.equal(urls.length,2);});
});
test('unpaired private chats never retrieve document text',async()=>{
 const urls=[];await mocked(async(input,init)=>{const url=String(input);urls.push(url);if(url.includes('/bots'))return json(bot);if(url.includes('/claim_telegram_update'))return json({state:'claimed',lease_token:'lease',payload:null,next_part:0});if(url.includes('/telegram_updates'))return json([{update_id:8}]);if(url.includes('/sendMessage')){assert.match(JSON.parse(init.body).text,/pair this private chat/);return json({ok:true,result:{}});}throw new Error('Unexpected retrieval: '+url);},async()=>{const res=await handleApi(request('/api/telegram/'+BOT,{update_id:8,message:{chat:{id:999,type:'private'},text:'What is attendance?'}},{'X-Telegram-Bot-Api-Secret-Token':'webhook-secret'}),env);assert.equal(res.status,200);assert.ok(!urls.some(u=>u.includes('nvidia.com')||u.includes('match_document')));});
});
test('absent evidence leads to a Telegram refusal without a generation call',async()=>{
 const urls=[];await mocked(async(input,init)=>{const url=String(input);urls.push(url);if(url.includes('/bots'))return json(bot);if(url.includes('/claim_telegram_update'))return json({state:'claimed',lease_token:'lease',payload:null,next_part:0});if(url.includes('/consume_request'))return json(true);if(url.includes('/embeddings'))return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});if(url.includes('/match_document_chunks')){const query=JSON.parse(init.body);assert.equal(query.p_owner_id,OWNER);assert.equal(query.p_bot_id,BOT);return json([]);}if(url.includes('/telegram_updates'))return json([{update_id:9}]);if(url.includes('/sendMessage')){assert.equal(JSON.parse(init.body).text,REFUSAL);return json({ok:true,result:{}});}throw new Error('Unexpected endpoint '+url);},async()=>{const res=await handleApi(request('/api/telegram/'+BOT,{update_id:9,message:{chat:{id:42,type:'private'},text:'Who won the World Cup?'}},{'X-Telegram-Bot-Api-Secret-Token':'webhook-secret'}),env);assert.equal(res.status,200);assert.ok(!urls.some(u=>u.includes('chat/completions')));});
});
