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
test('a PDF with more than 200 text pages is accepted within the new workspace limit',async()=>{
 let stored=0;
 await mocked(async(input,init)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/create_document')){const payload=JSON.parse(init.body);stored=payload.p_chunks.length;assert.equal(payload.p_owner_id,OWNER);assert.equal(payload.p_bot_id,BOT);assert.equal(payload.p_chunks.at(-1).page,201);return json(DOC);}throw new Error('Unexpected endpoint');},async()=>{
  const result=await handleApi(request('/api/documents/init',{title:'Long handbook.pdf',hash:'a'.repeat(64),pages:Array.from({length:201},(_,index)=>({page:index+1,text:'A readable handbook page.'}))}),env);
  assert.equal(result.status,200);assert.equal((await result.json()).chunks,201);assert.equal(stored,201);
 });
});
test('blank documents and full workspaces return useful input errors without exposing internal errors',async()=>{
 await mocked(async(input)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/create_document'))return new Response(JSON.stringify({code:'P0001',message:'Workspace limit: 500 chunks'}),{status:400,headers:{'Content-Type':'application/json'}});throw new Error('Unexpected endpoint');},async()=>{
  const base={title:'Handbook.pdf',hash:'a'.repeat(64)};
  const blank=await handleApi(request('/api/documents/init',{...base,pages:[{page:1,text:' '}]}),env);assert.equal(blank.status,400);assert.match((await blank.json()).error,/No readable text/);
  const large=await handleApi(request('/api/documents/init',{...base,pages:[{page:1,text:'x'.repeat(220001)}]}),env);assert.equal(large.status,413);assert.match((await large.json()).error,/220,000 characters/);
  const full=await handleApi(request('/api/documents/init',{...base,pages:[{page:1,text:'Readable content'}]}),env);assert.equal(full.status,400);assert.match((await full.json()).error,/500 chunks.*Delete an older document/);
 });
});
test('document processing creates passage embeddings and marks only the owned document ready',async()=>{
 let passage=false,updates=0,ready=false;
 await mocked(async(input,init)=>{const url=new URL(String(input));if(url.pathname==='/auth/v1/user')return json(authUser);if(url.pathname.endsWith('/bots'))return json(bot);if(url.pathname.endsWith('/consume_request'))return json(true);
  if(url.hostname==='integrate.api.nvidia.com'){const body=JSON.parse(init.body);assert.equal(body.input_type,'passage');assert.equal(body.input.length,2);passage=true;return json({data:body.input.map((_,index)=>({index,embedding:Array(2048).fill(.1)}))});}
  if(url.pathname.endsWith('/documents')){assert.equal(url.searchParams.get('owner_id'),'eq.'+OWNER);assert.equal(url.searchParams.get('bot_id'),'eq.'+BOT);if(init.method==='PATCH'){assert.equal(JSON.parse(init.body).status,'ready');ready=true;return new Response(null,{status:204});}return json({id:DOC,status:'processing'});}
  if(url.pathname.endsWith('/document_chunks')){assert.equal(url.searchParams.get('owner_id'),'eq.'+OWNER);assert.equal(url.searchParams.get('bot_id'),'eq.'+BOT);if(init.method==='PATCH'){assert.equal(JSON.parse(init.body).embedding.length,2048);updates++;return new Response(null,{status:204});}if(init.method==='HEAD')return new Response(null,{status:200,headers:{'Content-Range':'0-0/0'}});return json([{id:'chunk-a',content:'First paragraph.'},{id:'chunk-b',content:'Second paragraph.'}]);}throw new Error('Unexpected endpoint');
 },async()=>{const result=await handleApi(request('/api/documents/process',{id:DOC}),env);assert.equal(result.status,200);assert.deepEqual(await result.json(),{done:true,remaining:0});assert.ok(passage&&ready);assert.equal(updates,2);});
});
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
test('a retrieved fact becomes an answer only after generation and evidence verification',async()=>{
 const quote='Students must maintain a minimum attendance of 75% in each course.';
 const source={id:'owned-source',title:'Handbook.pdf',page:17,content:quote,similarity:.7};let chatCalls=0;
 await mocked(async(input,init)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/embeddings'))return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});if(url.includes('/match_document_chunks'))return json([source]);
  if(url.includes('/chat/completions')){const body=JSON.parse(init.body);assert.equal(body.model,'nvidia/nemotron-3-ultra-550b-a55b');assert.equal(body.reasoning_effort,'none');assert.ok(!('reasoning_budget' in body));chatCalls++;return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(chatCalls===1?{answerable:true,claims:[{text:'Minimum attendance is 75%.',chunkId:source.id,quote}]}:{supported:true})}}]});}throw new Error('Unexpected endpoint');
 },async()=>{const result=await handleApi(request('/api/chat',{question:'What is the attendance requirement?'}),env);assert.equal(result.status,200);const answer=await result.json();assert.equal(chatCalls,2);assert.equal(answer.grounded,true);assert.equal(answer.answer,'Minimum attendance is 75%.');assert.equal(answer.sources[0].page,17);assert.equal(answer.sources[0].quote,quote);});
});
test('a short topic can use a relevant low-score excerpt while invalid evidence is refused',async()=>{
 const quote='You can find the projected cost of attendance including tuition, room and board, and other fees on the financial aid website.';
 const source={id:'owned-cost-source',title:'Admission guide.pdf',page:91,content:quote,similarity:.273};
 for(const scenario of ['supported','unrelated','invented-quote','verification-rejected']){
  let chatCalls=0;
  await mocked(async(input,init)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/embeddings')){assert.equal(JSON.parse(init.body).input_type,'query');return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});}if(url.includes('/match_document_chunks')){const body=JSON.parse(init.body);assert.equal(body.p_owner_id,OWNER);assert.equal(body.p_bot_id,BOT);return json([source]);}
   if(url.includes('/chat/completions')){chatCalls++;const body=JSON.parse(init.body);if(chatCalls===1)assert.match(body.messages[0].content,/short topic phrase/);const generated=scenario==='unrelated'?{answerable:false,claims:[]}:{answerable:true,claims:[{text:'The projected cost includes tuition, room and board, and other fees.',chunkId:source.id,quote:scenario==='invented-quote'?'This quotation is not in the source.':quote}]};const verifying=body.messages[0].content.startsWith('Check evidence;');return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(verifying?{supported:scenario!=='verification-rejected'}:generated)}}]});}throw new Error('Unexpected endpoint');
  },async()=>{const result=await handleApi(request('/api/chat',{question:scenario==='unrelated'?'Who won the World Cup?':'cost of attendance'}),env);assert.equal(result.status,scenario==='invented-quote'?503:200);const answer=await result.json();assert.equal(chatCalls,scenario==='unrelated'?1:2);if(scenario==='invented-quote'){assert.match(answer.error,/could not be verified/);assert.ok(!answer.sources);}else{assert.equal(answer.grounded,scenario==='supported');if(scenario==='supported')assert.equal(answer.sources[0].page,91);else{assert.equal(answer.answer,REFUSAL);assert.deepEqual(answer.sources,[]);}}});
 }
});

test('a short citation is regenerated once from the same evidence and verified before answering',async()=>{
 const quote='This guide explains the college admission process.';
 const source={id:'owned-source',title:'Admission guide.pdf',page:1,content:quote,similarity:.3};let chatCalls=0,limits=0,searches=0;
 const logs=[],originalInfo=console.info;console.info=(...args)=>logs.push(args);
 try{await mocked(async(input,init)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request')){limits++;return json(true);}if(url.includes('/embeddings'))return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});if(url.includes('/match_document_chunks')){searches++;return json([source]);}
  if(url.includes('/chat/completions')){chatCalls++;const body=JSON.parse(init.body),payload=JSON.parse(body.messages[1].content);
   if(chatCalls===1){assert.match(body.messages[0].content,/12 to 1400/);assert.match(body.messages[0].content,/700 characters/);}
   if(chatCalls===2){assert.deepEqual(payload.validationIssue,{reason:'quote_length',claimIndex:0});assert.deepEqual(payload.excerpts,[{id:source.id,title:source.title,page:source.page,content:source.content}]);assert.ok(!('claims' in payload));assert.ok(!JSON.stringify(payload).includes('Rejected draft answer'));
   }
   const generated={answerable:true,claims:[{text:chatCalls===1?'Rejected draft answer':'Yes, this guide is about college admission.',chunkId:source.id,quote:chatCalls===1?'college':quote}]};return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(chatCalls===3?{supported:true}:generated)}}]});}throw new Error('Unexpected endpoint');
 },async()=>{const result=await handleApi(request('/api/chat',{question:'is it about college'}),env);assert.equal(result.status,200);const answer=await result.json();assert.equal(answer.grounded,true);assert.equal(answer.sources[0].quote,quote);assert.equal(chatCalls,3);assert.equal(limits,1);assert.equal(searches,1);});
 assert.deepEqual(logs[0],['document_answer',{stage:'citation_retry',retrieved:1,reason:'quote_length',claimIndex:0}]);assert.ok(!JSON.stringify(logs).includes(quote));assert.ok(!JSON.stringify(logs).includes('Rejected draft answer'));
 }finally{console.info=originalInfo;}
});

test('forged chunk IDs remain rejected after the single citation retry',async()=>{
 const source={id:'owned-source',title:'Handbook.pdf',page:17,content:'Students must maintain a minimum attendance of 75%.',similarity:.7};let chatCalls=0;
 await mocked(async(input)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/embeddings'))return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});if(url.includes('/match_document_chunks'))return json([source]);if(url.includes('/chat/completions')){chatCalls++;return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answerable:true,claims:[{text:'Minimum attendance is 75%.',chunkId:'another-student-chunk',quote:source.content}]})}}]});}throw new Error('Unexpected endpoint');},async()=>{const result=await handleApi(request('/api/chat',{question:'Attendance requirement?'}),env);assert.equal(result.status,503);assert.equal(chatCalls,2);assert.match((await result.json()).error,/could not be verified/);});
});

test('Telegram delivers an exhausted citation verification error once and completes the update',async()=>{
 const source={id:'owned-source',title:'Handbook.pdf',page:17,content:'Students must maintain a minimum attendance of 75%.',similarity:.7};let chatCalls=0,sends=0,completed=false,saved=false;
 await mocked(async(input,init)=>{const url=String(input);if(url.includes('/bots'))return json(bot);if(url.includes('/claim_telegram_update'))return json({state:'claimed',lease_token:'lease',payload:null,next_part:0});if(url.includes('/consume_request'))return json(true);if(url.includes('/embeddings'))return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});if(url.includes('/match_document_chunks'))return json([source]);
  if(url.includes('/chat/completions')){chatCalls++;return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answerable:true,claims:[{text:'Unsupported answer.',chunkId:source.id,quote:'This quote was fabricated.'}]})}}]});}
  if(url.includes('/telegram_updates')){const patch=JSON.parse(init.body);if(patch.payload){assert.equal(patch.payload.length,1);assert.match(patch.payload[0],/could not be verified/);saved=true;}if(patch.state==='done')completed=true;return json([{update_id:10}]);}
  if(url.includes('/sendMessage')){assert.ok(saved);sends++;assert.match(JSON.parse(init.body).text,/could not be verified/);return json({ok:true,result:{}});}throw new Error('Unexpected endpoint');
 },async()=>{const result=await handleApi(request('/api/telegram/'+BOT,{update_id:10,message:{chat:{id:42,type:'private'},text:'What is the attendance requirement?'}},{'X-Telegram-Bot-Api-Secret-Token':'webhook-secret'}),env);assert.equal(result.status,200);assert.equal(chatCalls,2);assert.equal(sends,1);assert.ok(completed);});
});

test('NVIDIA server retries are shared across answer calls and still require evidence verification',async()=>{
 const source={id:'owned-source',title:'Handbook.pdf',page:17,content:'Students must maintain a minimum attendance of 75%.',similarity:.7};
 const generated={answerable:true,claims:[{text:'Minimum attendance is 75%.',chunkId:source.id,quote:source.content}]};
 for(const scenario of ['generation-recovers','generation-exhausted','embedding-consumes-budget','verification-recovers']){
  let embeddingCalls=0,chatCalls=0;
  await mocked(async(input,init)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/match_document_chunks'))return json([source]);
   if(url.includes('/embeddings')){embeddingCalls++;if(scenario==='embedding-consumes-budget'&&embeddingCalls===1)return new Response(null,{status:503});return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});}
   if(url.includes('/chat/completions')){chatCalls++;const verifying=JSON.parse(init.body).messages[0].content.startsWith('Check evidence;');if(scenario==='generation-exhausted'||scenario==='embedding-consumes-budget'||(scenario==='generation-recovers'&&chatCalls===1)||(scenario==='verification-recovers'&&chatCalls===2))return new Response(null,{status:503});return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(verifying?{supported:true}:generated)}}]});}throw new Error('Unexpected endpoint');
  },async()=>{const res=await handleApi(request('/api/chat',{question:'Attendance requirement?'}),env),answer=await res.json();const success=scenario.endsWith('recovers');assert.equal(res.status,success?200:503);assert.equal(chatCalls,success?3:scenario==='generation-exhausted'?2:1);assert.equal(embeddingCalls,scenario==='embedding-consumes-budget'?2:1);if(success){assert.equal(answer.grounded,true);assert.equal(answer.sources[0].quote,source.content);}});
 }
});

test('NVIDIA auth, quota, asynchronous responses and fetch failures are never retried',async()=>{
 for(const failure of [401,403,429,202,'timeout']){
  let calls=0;
  await mocked(async(input)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/embeddings')){calls++;if(failure==='timeout')throw new DOMException('Timeout','TimeoutError');return new Response(null,{status:failure});}throw new Error('Unexpected endpoint');},async()=>{const res=await handleApi(request('/api/chat',{question:'Attendance requirement?'}),env);assert.equal(res.status,[401,403].includes(failure)?400:failure===429?429:503);assert.equal(calls,1);});
 }
});

test('NVIDIA retries keep their call deadline and citation repair respects the total answer deadline',async()=>{
 const quote='Students must maintain a minimum attendance of 75%.',source={id:'owned-source',title:'Handbook.pdf',page:17,content:quote,similarity:.7};
 const originalNow=Date.now,originalTimeout=AbortSignal.timeout;let now=1800000000000,lastTimeout=0,chatCalls=0,mode='http-retry',timeouts=[];
 Date.now=()=>now;AbortSignal.timeout=milliseconds=>{lastTimeout=milliseconds;return originalTimeout.call(AbortSignal,milliseconds);};
 try{await mocked(async(input,init)=>{const url=String(input);if(url.includes('/auth/v1/user'))return json(authUser);if(url.includes('/bots'))return json(bot);if(url.includes('/consume_request'))return json(true);if(url.includes('/match_document_chunks'))return json([source]);if(url.includes('/embeddings')){timeouts.push(lastTimeout);if(mode==='answer-deadline')now+=20000;return json({data:[{index:0,embedding:Array(2048).fill(.1)}]});}
  if(url.includes('/chat/completions')){chatCalls++;timeouts.push(lastTimeout);if(mode==='http-retry'&&chatCalls===1){now+=5000;return new Response(null,{status:503});}const verifying=JSON.parse(init.body).messages[0].content.startsWith('Check evidence;');if(mode==='answer-deadline')now+=chatCalls===1?39000:chatCalls===2?20000:0;const generated={answerable:true,claims:[{text:'Minimum attendance is 75%.',chunkId:source.id,quote:mode==='answer-deadline'&&chatCalls===1?'75%':quote}]};return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(verifying?{supported:true}:generated)}}]});}throw new Error('Unexpected endpoint');
 },async()=>{let res=await handleApi(request('/api/chat',{question:'Attendance?'}),env);assert.equal(res.status,200);assert.deepEqual(timeouts,[22000,40000,35000,40000]);mode='answer-deadline';chatCalls=0;timeouts=[];res=await handleApi(request('/api/chat',{question:'Attendance?'}),env);assert.equal(res.status,200);assert.deepEqual(timeouts,[22000,40000,31000,11000]);});
 }finally{Date.now=originalNow;AbortSignal.timeout=originalTimeout;}
});

test('Telegram send failures do not use the NVIDIA HTTP retry',async()=>{
 let sends=0;await mocked(async(input)=>{const url=String(input);if(url.includes('/bots'))return json(bot);if(url.includes('/claim_telegram_update'))return json({state:'claimed',lease_token:'lease',payload:null,next_part:0});if(url.includes('/telegram_updates'))return json([{update_id:11}]);if(url.includes('/sendMessage')){sends++;return new Response(null,{status:503});}throw new Error('Unexpected endpoint');},async()=>{const res=await handleApi(request('/api/telegram/'+BOT,{update_id:11,message:{chat:{id:999,type:'private'},text:'hi'}},{'X-Telegram-Bot-Api-Secret-Token':'webhook-secret'}),env);assert.equal(res.status,503);assert.equal(sends,1);});
});
