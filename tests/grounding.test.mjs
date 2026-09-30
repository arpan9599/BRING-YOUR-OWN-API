import test from 'node:test';
import assert from 'node:assert/strict';
import {chunkPages,encryptSecret,decryptSecret,validateClaims,validateEmbedding,DIMENSIONS,parseJson} from '../lib/grounding.mjs';
const source={id:'own-source',title:'Handbook.pdf',page:17,content:'Students must maintain a minimum attendance of 75% in each course.'};
test('chunks preserve PDF page attribution and overlap without exceeding bounds',()=>{
 const text='important fact '.repeat(350),chunks=chunkPages([{page:17,text},{page:18,text:'Next page.'}]);
 assert.ok(chunks.length>2);assert.ok(chunks.every(c=>c.content.length<=1400));assert.equal(chunks[0].page,17);assert.equal(chunks.at(-1).page,18);assert.ok(chunks[1].content.startsWith(chunks[0].content.slice(-150)));
});
test('empty/scanned documents and excessive documents are rejected',()=>{assert.throws(()=>chunkPages([{page:1,text:' '}]),/No readable/);assert.throws(()=>chunkPages([{page:1,text:'x'.repeat(700000)}]),/500 chunks/);});
test('only exact evidence from retrieved authorized chunks can be cited',()=>{
 const candidate={answerable:true,claims:[{text:'Minimum attendance is 75%.',chunkId:source.id,quote:source.content}]};
 assert.equal(validateClaims(candidate,[source])[0].page,17);
 assert.equal(validateClaims({...candidate,claims:[{...candidate.claims[0],chunkId:'other-student-source'}]},[source]),null);
 assert.equal(validateClaims({...candidate,claims:[{...candidate.claims[0],quote:'The minimum attendance is 50%.'}]},[source]),null);
 assert.equal(validateClaims({answerable:false,claims:[]},[source]),null);
 assert.equal(validateClaims({answerable:true,claims:[{text:'Guess',chunkId:source.id,quote:'75%'}]},[source]),null);
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
