import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../lib/server.ts';
import {encryptSecret,sha256,REFUSAL} from '../lib/grounding.mjs';

// Invented training data; no handbook content or real student information.
const OWNER='11111111-1111-4111-8111-111111111111',BOT='22222222-2222-4222-8222-222222222222';
const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'secret-test',CREDENTIAL_ENCRYPTION_KEY:key,APP_URL:'https://docbot.test'};
const bot={id:BOT,owner_id:OWNER,status:'connected',telegram_bot_id:1234567,paired_chat_id:42,webhook_secret_sha256:await sha256('webhook-secret'),nvidia_key_encrypted:await encryptSecret(key,'test-nvidia',OWNER),telegram_token_encrypted:await encryptSecret(key,'1234567:test-token',OWNER)};
const source={id:'owned-award',title:'Invented training handbook',page:9,similarity:.28,content:'Bright Campus Entry Award. Eligibility: the top 12 students admitted in the merit category, with a test percentile of at least 75. Amount: Rs. 45,000 per eligible student, once during the two-year course. Payment: tuition-fee waivers in the second, third and fourth instalments.'};
const claims=[
 {text:'If you qualify for the Bright Campus Entry Award, the documented amount is Rs. 45,000 once during the two-year course.',chunkId:source.id,quote:'Bright Campus Entry Award. Eligibility: the top 12 students admitted in the merit category, with a test percentile of at least 75. Amount: Rs. 45,000 per eligible student, once during the two-year course.'},
 {text:'Eligibility requires a test percentile of at least 75 and being among the top 12 students admitted in the merit category.',chunkId:source.id,quote:'Eligibility: the top 12 students admitted in the merit category, with a test percentile of at least 75.'}
];
async function scenario({question='How much scholarship can I get?',telegram=false,chunks=[source],generate={answerable:true,claims},verify=true,verdict={factsSupported:verify,topicRelevant:verify}}={}){
 const nativeFetch=globalThis.fetch,calls=[],sent=[];
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),body=init?.body?JSON.parse(init.body):null;
  if(url.pathname==='/auth/v1/user')return Response.json({id:OWNER,aud:'authenticated',role:'authenticated',created_at:'2026-01-01',app_metadata:{},user_metadata:{}});
  if(url.pathname.endsWith('/bots'))return Response.json(bot);
  if(url.pathname.endsWith('/consume_request'))return Response.json(true);
  if(url.pathname.endsWith('/embeddings'))return Response.json({data:[{index:0,embedding:Array(2048).fill(.1)}]});
  if(url.pathname.endsWith('/match_document_chunks')){assert.equal(body.p_owner_id,OWNER);assert.equal(body.p_bot_id,BOT);return Response.json(chunks);}
  if(url.pathname.endsWith('/chat/completions')){calls.push(body);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(body.messages[0].content.startsWith('Check evidence;')?verdict:generate)}}]});}
  if(url.pathname.endsWith('/claim_telegram_update'))return Response.json({state:'claimed',lease_token:'lease',payload:null,next_part:0});
  if(url.pathname.endsWith('/telegram_updates'))return Response.json([{update_id:91}]);
  if(url.pathname.endsWith('/sendMessage')){sent.push(body.text);return Response.json({ok:true,result:{}});}
  throw new Error('Unexpected endpoint');
 };
 const headers=telegram?{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'webhook-secret'}:{Origin:env.APP_URL,Authorization:'Bearer session','Content-Type':'application/json'};
 const body=telegram?{update_id:91,message:{chat:{id:42,type:'private'},text:question}}:{question};
 try{const response=await handleApi(new Request(env.APP_URL+(telegram?'/api/telegram/'+BOT:'/api/chat'),{method:'POST',headers,body:JSON.stringify(body)}),env);return {status:response.status,body:await response.json(),calls,sent};}finally{globalThis.fetch=nativeFetch;}
}

test('personal scholarship amount is conditional, cited and consistent in browser and Telegram',async()=>{
 const web=await scenario();assert.equal(web.status,200);assert.equal(web.body.grounded,true);assert.match(web.body.answer,/If you qualify/);assert.match(web.body.answer,/45,000 once/);assert.equal(web.body.sources.length,2);assert.equal(web.body.sources[0].quote,claims[0].quote);
 assert.match(web.calls[0].messages[0].content,/Missing personal details do not make a documented benefit unanswerable/);
 assert.match(web.calls[1].messages[0].content,/two independent boolean fields/);assert.match(web.calls[1].messages[0].content,/A partial conditional answer is acceptable/);
 const telegram=await scenario({telegram:true});assert.equal(telegram.status,200);assert.equal(telegram.sent.length,2);assert.match(telegram.sent[0],/If you qualify/);assert.ok(telegram.sent.every(text=>text.includes('Source: Invented training handbook, page 9')));
});

test('unsupported award promises and recurring amounts fail evidence checks',async()=>{
 for(const text of ['You are guaranteed Rs. 45,000 because your percentile is 90.','You will receive Rs. 45,000 every year.','Your award will be paid tomorrow.','You cannot get any scholarship because your percentile is 70.']){
  const result=await scenario({question:'My test percentile is 90; how much am I guaranteed?',generate:{answerable:true,claims:[{...claims[0],text}]},verify:false});assert.equal(result.status,200);assert.equal(result.body.answer,REFUSAL);assert.deepEqual(result.body.sources,[]);
 }
});

test('missing scholarship evidence and fabricated benefits cannot become grounded answers',async()=>{
 const absent=await scenario({chunks:[]});assert.equal(absent.body.answer,REFUSAL);assert.equal(absent.calls.length,0);
 const unrelated=await scenario({question:'Who won the World Cup?',generate:{answerable:false,claims:[]}});assert.equal(unrelated.body.answer,REFUSAL);
 for(const claim of [{...claims[0],quote:'The amount is Rs. 90,000.'},{...claims[0],chunkId:'another-owner-award'}]){
  const invalid=await scenario({generate:{answerable:true,claims:[claim]}});assert.equal(invalid.status,503);assert.ok(!invalid.body.sources);
 }
});

test('factual support and question relevance must both pass with strict boolean verdicts',async()=>{
 for(const verdict of [{factsSupported:false,topicRelevant:true},{factsSupported:true,topicRelevant:false},{factsSupported:true},{factsSupported:'true',topicRelevant:true},{factsSupported:true,topicRelevant:1},{supported:true},{}]){
  const result=await scenario({verdict});assert.equal(result.status,200);assert.equal(result.body.answer,REFUSAL);assert.deepEqual(result.body.sources,[]);
 }
});
