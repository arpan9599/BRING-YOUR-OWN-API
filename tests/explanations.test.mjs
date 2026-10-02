import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../lib/server.ts';
import {encryptSecret,sha256,REFUSAL,ILLUSTRATION_LABEL} from '../lib/grounding.mjs';
const OWNER='11111111-1111-4111-8111-111111111111',BOT='22222222-2222-4222-8222-222222222222';
const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'secret-test',CREDENTIAL_ENCRYPTION_KEY:key,APP_URL:'https://docbot.test'};
const bot={id:BOT,owner_id:OWNER,status:'connected',telegram_bot_id:1234567,paired_chat_id:42,webhook_secret_sha256:await sha256('webhook-secret'),nvidia_key_encrypted:await encryptSecret(key,'test-nvidia',OWNER),telegram_token_encrypted:await encryptSecret(key,'1234567:test-token',OWNER)};
const source={id:'owned-prelude',title:'Handbook.pdf',page:21,similarity:.7,content:'The Prelude. This handbook gives students guidelines for academic and personal conduct. Students are expected to develop value-based conduct and emotional stability.'};
const facts=[{text:'The Prelude introduces the handbook and its guidance for student behaviour.',chunkId:source.id,quote:'The Prelude. This handbook gives students guidelines for academic and personal conduct.'}];
const illustration={text:'Imagine a new student reading the opening section to understand why responsible behaviour matters.',claimIndex:0};
const request=(question,telegram=false)=>new Request(env.APP_URL+(telegram?'/api/telegram/'+BOT:'/api/chat'),{method:'POST',headers:telegram?{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'webhook-secret'}:{Origin:env.APP_URL,Authorization:'Bearer session','Content-Type':'application/json'},body:JSON.stringify(telegram?{update_id:90,message:{chat:{id:42,type:'private'},text:question}}:{question})});
async function scenario({question='Explain Prelude in easy language with example',telegram=false,generate={answerable:true,claims:facts,illustration},verify=true,chunks=[source]}){
 const nativeFetch=globalThis.fetch,calls=[],sent=[],saved=[];
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),body=init?.body?JSON.parse(init.body):null;
  if(url.pathname==='/auth/v1/user')return Response.json({id:OWNER,aud:'authenticated',role:'authenticated',created_at:'2026-01-01',app_metadata:{},user_metadata:{}});
  if(url.pathname.endsWith('/bots'))return Response.json(bot);
  if(url.pathname.endsWith('/consume_request'))return Response.json(true);
  if(url.pathname.endsWith('/embeddings'))return Response.json({data:[{index:0,embedding:Array(2048).fill(.1)}]});
  if(url.pathname.endsWith('/match_document_chunks')){assert.equal(body.p_owner_id,OWNER);assert.equal(body.p_bot_id,BOT);return Response.json(chunks);}
  if(url.pathname.endsWith('/chat/completions')){
   calls.push(body);const verifying=body.messages[0].content.startsWith('Check evidence;');
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(verifying?{supported:verify}:generate)}}]});
  }
  if(url.pathname.endsWith('/claim_telegram_update'))return Response.json({state:'claimed',lease_token:'lease',payload:null,next_part:0});
  if(url.pathname.endsWith('/telegram_updates')){if(body.payload)saved.push(body.payload);return Response.json([{update_id:90}]);}
  if(url.pathname.endsWith('/sendMessage')){sent.push(body.text);return Response.json({ok:true,result:{}});}
  throw new Error('Unexpected endpoint');
 };
 try{const result=await handleApi(request(question,telegram),env);return {status:result.status,body:await result.json(),calls,sent,saved};}finally{globalThis.fetch=nativeFetch;}
}
test('requested examples accompany verified facts in browser and durable Telegram delivery',async()=>{
 const web=await scenario({});assert.equal(web.status,200);assert.ok(web.body.answer.includes(ILLUSTRATION_LABEL));assert.equal(web.body.sources.length,1);assert.equal(web.body.sources[0].quote,facts[0].quote);assert.ok(!JSON.stringify(web.body.sources).includes(illustration.text));
 const evidence=JSON.parse(web.calls[0].messages[1].content),verification=JSON.parse(web.calls[1].messages[1].content);assert.equal(evidence.allowIllustration,true);assert.deepEqual(verification.illustration,illustration);
 const telegram=await scenario({telegram:true});assert.equal(telegram.status,200);assert.equal(telegram.sent.length,2);assert.ok(telegram.sent[0].includes('Source: Handbook.pdf, page 21'));assert.equal(telegram.sent[1],ILLUSTRATION_LABEL+' '+illustration.text);assert.deepEqual(telegram.saved[0],telegram.sent);
});
test('ordinary explanations and explicit exclusions do not add illustrations',async()=>{
 for(const question of ['meaning of Prelude','Explain Prelude without examples','Give an example from the handbook','Show an example documented in the uploaded file']){
  const result=await scenario({question,generate:{answerable:true,claims:facts}});assert.equal(result.status,200);assert.equal(result.body.illustration,null);assert.ok(!result.body.answer.includes(ILLUSTRATION_LABEL));assert.equal(JSON.parse(result.calls[0].messages[1].content).allowIllustration,false);
 }
 for(const question of ['meaning of Prelude','Give an example from the handbook','Show an example documented in the uploaded file']){
  const unwanted=await scenario({question});assert.equal(unwanted.status,503);assert.equal(unwanted.calls.length,2);assert.ok(!JSON.stringify(unwanted.body).includes(illustration.text));
 }
});
test('examples cannot rescue missing evidence, absent topics, fabricated citations or rejected verification',async()=>{
 const empty=await scenario({chunks:[]});assert.equal(empty.body.answer,REFUSAL);assert.equal(empty.calls.length,0);
 const unrelated=await scenario({question:'Who won the FIFA World Cup in 2018 with an example?',generate:{answerable:false,claims:[],illustration}});assert.equal(unrelated.body.answer,REFUSAL);assert.equal(unrelated.calls.length,1);
 for(const generate of [{answerable:true,claims:[],illustration},{answerable:true,claims:[{...facts[0],chunkId:'another-owner'}],illustration},{answerable:true,claims:[{...facts[0],quote:'A fabricated quote.'}],illustration},{answerable:true,claims:facts}]){
  const result=await scenario({generate});assert.equal(result.status,503);assert.equal(result.calls.length,2);assert.ok(!result.body.sources);
 }
 for(const text of ['The college actually requires all students to pay a fictional new fee.','Imagine that value-based conduct means breaking the college rules.']){
  const result=await scenario({generate:{answerable:true,claims:facts,illustration:{text,claimIndex:0}},verify:false});assert.equal(result.body.answer,REFUSAL);assert.deepEqual(result.body.sources,[]);assert.equal(result.body.illustration,null);
 }
});
test('situational questions apply sourced rules without inventing penalties or unrelated answers',async()=>{
 const rule={id:'owned-session-rule',title:'Invented training manual',page:3,similarity:.4,content:'No shouting or pushing during sessions. Report session rule breaches to the organizer.'};
 const claims=[{text:'The training manual bans shouting and pushing during sessions.',chunkId:rule.id,quote:'No shouting or pushing during sessions.'},{text:'Report session rule breaches to the organizer.',chunkId:rule.id,quote:'Report session rule breaches to the organizer.'}];
 const good=await scenario({question:'If I had a fight during a session, what should I do?',chunks:[rule],generate:{answerable:true,claims}});assert.equal(good.status,200);assert.equal(good.body.grounded,true);assert.equal(good.body.sources.length,2);assert.match(good.calls[0].messages[0].content,/hypothetical situation/);assert.match(good.calls[1].messages[0].content,/Reject invented contacts, procedures, punishments/);
 const invented=await scenario({question:'What happens after a fight?',chunks:[rule],generate:{answerable:true,claims:[{...claims[0],text:'You will automatically be expelled.'}]},verify:false});assert.equal(invented.body.answer,REFUSAL);
 const unrelated=await scenario({question:'How do I bake a cake?',chunks:[rule],generate:{answerable:false,claims:[]}});assert.equal(unrelated.body.answer,REFUSAL);
});
