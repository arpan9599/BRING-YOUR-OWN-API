import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../lib/server.ts';
import {encryptSecret,sha256} from '../lib/grounding.mjs';
const OWNER='11111111-1111-4111-8111-111111111111',BOT='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
const token='1234567:fake-telegram-token-for-tests-only',key=btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'secret-test',CREDENTIAL_ENCRYPTION_KEY:key,APP_URL:'https://docbot.test'};
const bot={id:BOT,owner_id:OWNER,status:'connected',telegram_bot_id:1234567,telegram_username:'student_bot',paired_chat_id:42,webhook_secret_sha256:await sha256('webhook-secret'),nvidia_key_encrypted:await encryptSecret(key,'saved-nvidia',OWNER),telegram_token_encrypted:await encryptSecret(key,token,OWNER)};
const req=(path,body={})=>new Request(env.APP_URL+path,{method:'POST',headers:{Origin:env.APP_URL,Authorization:'Bearer session','Content-Type':'application/json'},body:JSON.stringify(body)});
async function connect({existing=null,other={id:OTHER,owner_id:OTHER},input={},invalidToken=false,aiFailure=false,busy=false,finish=true,setFailure=false,external=false,path='/api/bot'}={}){
 const native=globalThis.fetch,calls=[];let registered=false;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(String(url)),body=init?.body?JSON.parse(init.body):null;calls.push({path:u.pathname,body,headers:init?.headers});
  if(u.pathname==='/auth/v1/user')return Response.json({id:OWNER,aud:'authenticated',role:'authenticated',created_at:'2026-01-01',app_metadata:{},user_metadata:{}});
  if(u.pathname.endsWith('/bots'))return Response.json(u.searchParams.has('telegram_bot_id')?other:existing);
  if(u.pathname.endsWith('/getMe'))return invalidToken?new Response(null,{status:401}):Response.json({ok:true,result:{id:1234567,is_bot:true,username:'student_bot'}});
  if(u.pathname.endsWith('/getWebhookInfo'))return Response.json({ok:true,result:{url:external?'https://another.test/webhook':env.APP_URL+'/api/telegram/'+(other?.id||BOT)}});
  if(u.pathname.endsWith('/embeddings'))return aiFailure?new Response(null,{status:401}):Response.json({data:[{index:0,embedding:Array(2048).fill(.1)}]});
  if(u.pathname.endsWith('/chat/completions'))return Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});
  if(u.pathname.endsWith('/reserve_bot_connection')||u.pathname.endsWith('/reserve_bot_disconnect')){
   assert.equal(body.p_owner_id,OWNER);assert.equal(body.p_telegram_bot_id,1234567);
   if(busy)return Response.json({code:'P0001',message:'Bot connection in progress'},{status:400});
   return Response.json(u.pathname.endsWith('/reserve_bot_disconnect')?'lease':{lease_token:'lease',moved:!!other&&other.owner_id!==OWNER});
  }
  if(u.pathname.endsWith('/setWebhook')){registered=true;return setFailure?new Response(null,{status:503}):Response.json({ok:true,result:true});}
  if(u.pathname.endsWith('/finish_bot_connection')){assert.ok(registered);return Response.json(finish);}
  if(u.pathname.endsWith('/release_bot_connection'))return Response.json(null);
  if(u.pathname.endsWith('/deleteWebhook'))return Response.json({ok:true,result:true});
  throw new Error('Unexpected endpoint');
 };
 try{const r=await handleApi(req(path,{nvidiaKey:'new-nvidia',telegramToken:token,...input}),env);return {status:r.status,body:await r.json(),calls};}finally{globalThis.fetch=native;}
}
const called=(r,name)=>r.calls.filter(c=>c.path.endsWith('/'+name));
test('another workspace needs explicit reconnect after token verification, with no old data returned',async()=>{
 const r=await connect();assert.equal(r.status,409);assert.equal(r.body.requiresReconnect,true);assert.equal(called(r,'getMe').length,1);assert.equal(called(r,'reserve_bot_connection').length,0);assert.equal(called(r,'embeddings').length,0);assert.ok(!JSON.stringify(r.body).includes(OTHER));
 const bad=await connect({invalidToken:true,input:{reconnectWorkspace:true}});assert.equal(bad.status,400);assert.equal(called(bad,'reserve_bot_connection').length,0);
});
test('confirmed reconnect verifies new credentials and changes only the Telegram binding',async()=>{
 const r=await connect({input:{reconnectWorkspace:true,owner_id:OTHER,bot_id:OTHER}});assert.equal(r.status,200);
 const prepared=called(r,'reserve_bot_connection')[0].body;assert.equal(prepared.p_owner_id,OWNER);assert.notEqual(prepared.p_bot_id,OTHER);assert.equal(prepared.p_reconnect,true);
 assert.ok(r.calls.findIndex(c=>c.path.endsWith('/chat/completions'))<r.calls.findIndex(c=>c.path.endsWith('/reserve_bot_connection')));
 assert.equal(called(r,'setWebhook')[0].body.drop_pending_updates,true);assert.equal(called(r,'release_bot_connection').length,1);
 assert.ok(!r.calls.some(c=>/documents|document_chunks/.test(c.path)));
 const outside=await connect({external:true,input:{reconnectWorkspace:true}});assert.equal(outside.status,409);assert.equal(outside.body.requiresReplacement,true);assert.equal(called(outside,'reserve_bot_connection').length,0);
});
test('same-owner reconnect can keep its saved NVIDIA key and does not drop pending updates',async()=>{
 const r=await connect({existing:bot,other:{id:BOT,owner_id:OWNER},input:{nvidiaKey:''}});assert.equal(r.status,200);assert.equal(called(r,'reserve_bot_connection')[0].body.p_bot_id,BOT);assert.equal(called(r,'setWebhook')[0].body.drop_pending_updates,false);
 assert.equal(called(r,'embeddings')[0].headers.Authorization,'Bearer saved-nvidia');
});
test('failed preflight, busy reservation, stale finalization and provider failure cannot silently succeed',async()=>{
 const ai=await connect({aiFailure:true,input:{reconnectWorkspace:true}});assert.equal(ai.status,400);assert.equal(called(ai,'reserve_bot_connection').length,0);
 const busy=await connect({busy:true,input:{reconnectWorkspace:true}});assert.equal(busy.status,409);assert.match(busy.body.error,/45 seconds/);assert.equal(called(busy,'setWebhook').length,0);
 for(const options of [{finish:false},{setFailure:true}]){const r=await connect({...options,input:{reconnectWorkspace:true}});assert.equal(r.status,options.finish===false?409:503);assert.equal(called(r,'release_bot_connection').length,options.setFailure?0:1);}
});
test('disconnect releases only the verified owner binding and leaves documents and NVIDIA key intact',async()=>{
 const r=await connect({existing:bot,other:null,path:'/api/bot/disconnect',input:{owner_id:OTHER}});assert.equal(r.status,200);assert.equal(called(r,'reserve_bot_disconnect')[0].body.p_bot_id,BOT);assert.equal(called(r,'deleteWebhook').length,1);assert.ok(!r.calls.some(c=>/documents|document_chunks|nvidia.com/.test(c.path)));
 const external=await connect({existing:bot,path:'/api/bot/disconnect',external:true});assert.equal(external.status,200);assert.equal(called(external,'deleteWebhook').length,0);
 const detached=await connect({existing:{...bot,status:'disconnected',telegram_bot_id:null,telegram_token_encrypted:null},path:'/api/pair'});assert.equal(detached.status,400);
});
test('disconnected and revoked webhook generations cannot send previously prepared private replies',async()=>{
 const native=globalThis.fetch;
 try{for(const initialDetached of [true,false]){
  let reads=0,sends=0;
  globalThis.fetch=async(url)=>{const p=new URL(String(url)).pathname;if(p.endsWith('/bots')){reads++;return Response.json(initialDetached||reads>1?{...bot,status:'disconnected',telegram_bot_id:null,telegram_token_encrypted:null}:bot);}if(p.endsWith('/claim_telegram_update'))return Response.json({state:'claimed',lease_token:'lease',payload:['Old private reply'],next_part:0});if(p.endsWith('/sendMessage')){sends++;throw new Error('Must not send');}throw new Error('Unexpected call');};
  const request=new Request(env.APP_URL+'/api/telegram/'+BOT,{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'webhook-secret'},body:JSON.stringify({update_id:5,message:{chat:{id:42,type:'private'},text:'question'}})});
  const r=await handleApi(request,env);assert.equal(r.status,initialDetached?403:200);assert.equal(sends,0);
 }}finally{globalThis.fetch=native;}
});
