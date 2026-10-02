import test from 'node:test';
import assert from 'node:assert/strict';
import {chunkPages,cleanDocumentText,encryptSecret,decryptSecret,validateClaims,validateClaimsDetailed,validateAnswerDetailed,requestsIllustration,validateEmbedding,DIMENSIONS,parseJson} from '../lib/grounding.mjs';
const source={id:'own-source',title:'Handbook.pdf',page:17,content:'Students must maintain a minimum attendance of 75% in each course.'};
test('chunks preserve PDF page attribution and overlap without exceeding bounds',()=>{
 const text='important fact '.repeat(350),chunks=chunkPages([{page:17,text},{page:18,text:'Next page.'}]);
 assert.ok(chunks.length>2);assert.ok(chunks.every(c=>c.content.length<=1400));assert.equal(chunks[0].page,17);assert.equal(chunks.at(-1).page,18);assert.ok(chunks[1].content.startsWith(chunks[0].content.slice(-150)));
});
test('empty/scanned documents and excessive documents are rejected',()=>{assert.throws(()=>chunkPages([{page:1,text:' '}]),/No readable/);assert.throws(()=>chunkPages([{page:1,text:'x'.repeat(700000)}]),/500 chunks/);});

test('PDF null characters are removed while multilingual text and page citations survive',()=>{
 const text='पहला café 😀 first\u0000second';
 assert.deepEqual(chunkPages([{page:17,text}]),[{page:17,content:'पहला café 😀 firstsecond'}]);
 assert.throws(()=>chunkPages([{page:1,text:'\u0000 \n\u0000'}]),/No readable/);
 assert.equal(cleanDocumentText('valid 😀\uD800'), 'valid 😀\uFFFD');
});

test('chunk and overlap boundaries preserve whole Unicode characters',()=>{
 for(const prefix of [1399,1249]){
  const chunks=chunkPages([{page:1,text:'x'.repeat(prefix)+'😀'+'y'.repeat(1800)}]);
  assert.ok(chunks.length>1);
  assert.ok(chunks.every(c=>c.content.length<=1400&&c.content.isWellFormed()));
  assert.ok(chunks.some(c=>c.content.includes('😀')));
 }
});
test('only exact evidence from retrieved authorized chunks can be cited',()=>{
 const candidate={answerable:true,claims:[{text:'Minimum attendance is 75%.',chunkId:source.id,quote:source.content}]};
 assert.equal(validateClaims(candidate,[source])[0].page,17);
 assert.equal(validateClaims({...candidate,claims:[{...candidate.claims[0],chunkId:'other-student-source'}]},[source]),null);
 assert.equal(validateClaims({...candidate,claims:[{...candidate.claims[0],quote:'The minimum attendance is 50%.'}]},[source]),null);
 assert.equal(validateClaims({answerable:false,claims:[]},[source]),null);
 assert.equal(validateClaims({answerable:true,claims:[{text:'Guess',chunkId:source.id,quote:'75%'}]},[source]),null);
});
test('citation diagnostics preserve strict boundaries and contain no document or answer text',()=>{
 const longSource={...source,content:'a'.repeat(1401)};
 const candidate=(quote='a'.repeat(12),text='Supported answer.')=>({answerable:true,claims:[{text,chunkId:source.id,quote}]});
 for(const length of [11,12,1400,1401])assert.equal(validateClaimsDetailed(candidate('a'.repeat(length)),[longSource]).issue?.reason??null,[12,1400].includes(length)?null:'quote_length');
 for(const length of [700,701])assert.equal(validateClaimsDetailed(candidate(undefined,'t'.repeat(length)),[longSource]).issue?.reason??null,length===700?null:'text_length');
 for(const count of [0,1,4,5])assert.equal(validateClaimsDetailed({answerable:true,claims:Array(count).fill(candidate().claims[0])},[longSource]).issue?.reason??null,[1,4].includes(count)?null:'invalid_count');
 const bad={...candidate().claims[0],quote:'A fabricated private sentence.'};
 const rejected=validateClaimsDetailed({answerable:true,claims:[candidate().claims[0],bad]},[longSource]);
 assert.equal(rejected.claims,null);assert.deepEqual(rejected.issue,{reason:'quote_not_exact',claimIndex:1});assert.ok(!JSON.stringify(rejected).includes(bad.quote));
 assert.equal(validateClaimsDetailed({answerable:true,claims:[{...bad,chunkId:'another-owner'}]},[longSource]).issue.reason,'unknown_chunk');
});

test('illustrations require an explicit request, an existing sourced claim and bounded structure',()=>{
 for(const question of ['explain Prelude with example','Give me a simple example','Explain using an analogy','make example for this concept'])assert.equal(requestsIllustration(question),true);
 for(const question of ['meaning of Prelude','do not give an example','explain without any examples','give an actual example from the document','Give an example from the handbook','Show an example documented in the uploaded file','Explain with an example in this PDF','what does example mean?'])assert.equal(requestsIllustration(question),false);
 const candidate={answerable:true,claims:[{text:'Minimum attendance is 75%.',chunkId:source.id,quote:source.content}],illustration:{text:'Imagine a student following the attendance rule.',claimIndex:0}};
 assert.equal(validateAnswerDetailed(candidate,[source],true).illustration.claimIndex,0);
 assert.equal(validateAnswerDetailed(candidate,[source],false).issue.reason,'unexpected_illustration');
 assert.equal(validateAnswerDetailed({...candidate,illustration:null},[source],true).issue.reason,'missing_illustration');
 for(const illustration of [{text:'Example.'},{text:'Example.',claimIndex:1},{text:'Example.',claimIndex:-1},{text:'Example.',claimIndex:.5},{text:'x'.repeat(701),claimIndex:0}])assert.equal(validateAnswerDetailed({...candidate,illustration},[source],true).claims,null);
 assert.equal(validateAnswerDetailed({...candidate,claims:[]},[source],true).claims,null);
 assert.equal(validateAnswerDetailed({...candidate,claims:[{...candidate.claims[0],quote:'An invented quotation.'}]},[source],true).issue.reason,'quote_not_exact');
});
test('encrypted credentials are bound to their workspace and authenticated',async()=>{
 const key=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
 const cipher=await encryptSecret(key,'test-secret','student-a');assert.ok(!cipher.includes('test-secret'));
 assert.equal(await decryptSecret(key,cipher,'student-a'),'test-secret');
 await assert.rejects(decryptSecret(key,cipher,'student-b'));
 const changed=cipher.slice(0,-4)+'AAAA';await assert.rejects(decryptSecret(key,changed,'student-a'));
});
test('incompatible or nonfinite vectors are rejected',()=>{assert.equal(validateEmbedding(Array(DIMENSIONS).fill(.2)).length,2048);assert.throws(()=>validateEmbedding(Array(1024).fill(0)));assert.throws(()=>validateEmbedding([...Array(2047).fill(0),NaN]));});
test('JSON code fences are accepted but invented text is rejected',()=>{assert.deepEqual(parseJson('```json\n{"answerable":false}\n```'),{answerable:false});assert.throws(()=>parseJson('Here is an answer: 75%'));});
