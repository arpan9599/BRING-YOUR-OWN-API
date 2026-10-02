/* eslint-disable @next/next/no-html-link-for-pages -- Full browser navigation avoids a Vinext Link runtime compatibility failure. */
'use client';
import {useEffect,useRef,useState} from 'react';
import {type SupabaseClient} from '@supabase/supabase-js';
import {openWorkspace} from '../lib/workspace-client';
import {ArrowRight,BookOpen,Check,ChevronDown,FileText,KeyRound,LoaderCircle,MessageCircle,Send,ShieldCheck,Trash2,Upload,X} from 'lucide-react';
import {REFUSAL,MAX_CHUNKS,cleanDocumentText} from '../lib/grounding.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
type Config={configured:boolean;supabaseUrl:string|null;anonKey:string|null;sharedKey:boolean};
type Bot={id:string;username:string;status:string;paired:boolean};
type Doc={id:string;title:string;status:string};
type Source={chunkId:string;quote:string;title:string;page:number|null};
type Message={role:'user'|'assistant';text:string;sources?:Source[];error?:boolean};
type Pages={page:number|null;text:string}[];
type ApiData={error?:string;message?:string;requiresReplacement?:boolean;requiresReconnect?:boolean;bot:Bot|null;documents:Doc[];id:string;done:boolean;remaining:number;url:string;answer:string;sources:Source[]};
class ApiError extends Error{constructor(message:string,public replacement=false,public reconnect=false){super(message);}}
async function extract(file:File){
  if(file.size>5*1024*1024)throw new Error('Choose a file smaller than 5 MB.');
  const buffer=await file.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const ext=file.name.split('.').pop()?.toLowerCase();let pages:Pages;
  if(ext==='pdf'){
    const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc=pdfWorkerUrl;
    const pdf=await pdfjs.getDocument({data:new Uint8Array(buffer)}).promise;
    try{if(pdf.numPages>300)throw new Error('Choose a PDF with 300 pages or fewer.');pages=[];for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);const content=await page.getTextContent();pages.push({page:n,text:content.items.map(item=>'str' in item?item.str:'').join(' ')});page.cleanup();}}finally{await pdf.destroy();}
  }else if(ext==='docx'){const mammoth=await import('mammoth/mammoth.browser');pages=[{page:null,text:(await mammoth.extractRawText({arrayBuffer:buffer})).value}];}
  else if(ext==='txt'||ext==='md')pages=[{page:null,text:new TextDecoder().decode(buffer)}];
  else throw new Error('Choose a PDF, DOCX, TXT, or Markdown document.');
  pages=pages.map(p=>({...p,text:cleanDocumentText(p.text)}));
  if(!pages.some(p=>p.text.trim()))throw new Error('No readable text found. Scanned PDFs need OCR before uploading.');
  if(pages.reduce((total,p)=>total+p.text.length,0)>220_000)throw new Error('Too much text for the classroom limit. Choose a shorter document.');
  return {pages,hash};
}
export default function Home(){
  const [config,setConfig]=useState<Config|null>(null),[client,setClient]=useState<SupabaseClient|null>(null),[ready,setReady]=useState(false);
  const [bot,setBot]=useState<Bot|null>(null),[docs,setDocs]=useState<Doc[]>([]),[nvidiaKey,setNvidiaKey]=useState(''),[telegramToken,setTelegramToken]=useState(''),[code,setCode]=useState(''),[shared,setShared]=useState(false);
  const [busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState(''),[replace,setReplace]=useState<'workspace'|'website'|null>(null),[reconnect,setReconnect]=useState(false),[pairUrl,setPairUrl]=useState('');
  const [question,setQuestion]=useState(''),[messages,setMessages]=useState<Message[]>([]),[sample,setSample]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null),scroll=useRef<HTMLDivElement>(null);
  async function api(path:string,body?:unknown,s=client){
    const session=s?(await s.auth.getSession()).data.session:null;
    const res=await fetch(path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Authorization:`Bearer ${session.access_token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json() as ApiData;if(!res.ok)throw new ApiError(data.error||data.message||'Please retry.',!!data.requiresReplacement,!!data.requiresReconnect);return data;
  }
  async function refresh(s=client){const data=await api('/api/state',undefined,s);setBot(data.bot);setDocs(data.documents);if(data.bot?.paired||data.bot?.status!=='connected')setPairUrl('');}
  useEffect(()=>{let cancelled=false;(async()=>{try{
    const c:Config=await(await fetch('/api/config')).json();if(cancelled)return;setConfig(c);setShared(c.sharedKey);
    if(c.configured&&c.supabaseUrl&&c.anonKey){const s=await openWorkspace(c.supabaseUrl,c.anonKey);if(cancelled)return;setClient(s);await refresh(s);}
  }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'Unable to open workspace.');}finally{if(!cancelled)setReady(true);}})();return()=>{cancelled=true;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'smooth'});},[messages,busy]);
  useEffect(()=>{const focus=()=>{if(client)refresh().catch(()=>{});};window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);});
  const failure=(e:unknown)=>setError(e instanceof Error?e.message:'Please retry.');
  async function create(replacing=false,reconnecting=false){setError('');setNotice('');setBusy('connection');try{await api('/api/bot',{nvidiaKey:shared?undefined:nvidiaKey.trim(),telegramToken:telegramToken.trim(),classroomCode:code,replaceWebhook:replacing,reconnectWorkspace:reconnecting||reconnect});await refresh();setNvidiaKey('');setTelegramToken('');setCode('');setReplace(null);setReconnect(false);setNotice('Bot connected. Your workspace is saved in this browser.');}catch(e){if(e instanceof ApiError&&e.reconnect){setReconnect(true);setReplace('workspace');}else if(e instanceof ApiError&&e.replacement)setReplace('website');else failure(e);}finally{setBusy('');}}
  async function disconnect(){setError('');setNotice('');setBusy('connection');try{const result=await api('/api/bot/disconnect',{});setPairUrl('');await refresh();setNotice(result.message||'Telegram disconnected. Your documents remain here.');}catch(e){failure(e);}finally{setBusy('');}}
  async function processDocument(id:string){let result;do{result=await api('/api/documents/process',{id});setBusy(result.done?'Document ready':`Creating embeddings · ${result.remaining} chunks left`);}while(!result.done);await refresh();setNotice('Your document is ready. Try a question in the answer panel.');}
  async function upload(file?:File){if(!file)return;setError('');setNotice('');setBusy('Reading document…');try{const extracted=await extract(file);setBusy('Splitting text into chunks…');const result=await api('/api/documents/init',{title:file.name,...extracted});await refresh();await processDocument(result.id);}catch(e){failure(e);await refresh().catch(()=>{});}finally{setBusy('');if(fileInput.current)fileInput.current.value='';}}
  async function resume(id:string){setBusy('Resuming embeddings…');setError('');try{await processDocument(id);}catch(e){failure(e);}finally{setBusy('');}}
  async function remove(doc:Doc){if(!confirm(`Delete “${doc.title}” and its stored text?`))return;setBusy('Deleting…');try{await api('/api/documents/delete',{id:doc.id});await refresh();setMessages([]);}catch(e){failure(e);}finally{setBusy('');}}
  async function pair(){setBusy('pairing');try{const result=await api('/api/pair',{});setPairUrl(result.url);await refresh();}catch(e){failure(e);}finally{setBusy('');}}
  function walkthrough(){setSample(true);setMessages([]);setNotice('Sample walkthrough: fixed handbook answers. Connect your workspace to use live NVIDIA AI.');setError('');}
  async function ask(text=question){const q=text.trim();if(!q||busy)return;setQuestion('');setMessages(m=>[...m,{role:'user',text:q}]);setBusy('answer');try{
    if(sample){const attendance=/attendance|classes.*miss/i.test(q);setMessages(m=>[...m,{role:'assistant',text:attendance?'The minimum attendance requirement is 75%.':REFUSAL,sources:attendance?[{chunkId:'sample',title:'Sample College Handbook',page:17,quote:'Students must maintain a minimum attendance of 75% in each course.'}]:[]}]);}
    else{const result=await api('/api/chat',{question:q});setMessages(m=>[...m,{role:'assistant',text:result.answer,sources:result.sources}]);}
  }catch(e){setMessages(m=>[...m,{role:'assistant',text:e instanceof Error?e.message:'Please retry.',error:true}]);}finally{setBusy('');}}
  const hasReady=docs.some(d=>d.status==='ready'),canAsk=sample||hasReady;
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><BookOpen size={19}/></span>DocBot<span className="brand-light">Lab</span></a><div className="top-right"><span className="private-tag"><ShieldCheck size={14}/>Private workspace</span><a href="/setup">Teacher setup <ArrowRight size={14}/></a></div></header>
    <main><div className="intro"><div><p className="eyebrow">BUILD YOUR OWN KNOWLEDGE ASSISTANT</p><h1>Your documents. Your answers.</h1><p className="subtitle">Add a document. Ask a question. Take your assistant to Telegram.</p></div><button className="sample-button" onClick={walkthrough}>Try sample walkthrough <ArrowRight size={16}/></button></div>
      {!ready&&<div className="banner"><LoaderCircle className="spin" size={18}/>Opening your workspace…</div>}
      {config&&!config.configured&&<div className="banner setup-banner"><KeyRound size={19}/><div><strong>One-time host setup needed</strong><span>Connect Supabase to enable live uploads and answers. Students won’t need a Supabase account.</span></div><a href="/setup">View setup <ArrowRight size={15}/></a></div>}
      {error&&<div className="banner error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={17}/></button></div>}
      {notice&&<div className="banner success" role="status"><Check size={17}/><span>{notice}</span></div>}
      <div className="workspace-grid"><div className="setup-column">
        <section className="card"><div className="card-heading"><span className={`step ${bot?.status==='connected'?'complete':''}`}>{bot?.status==='connected'?<Check size={15}/>:1}</span><div><h2>Connect your model</h2><p>NVIDIA provides the AI. You bring the knowledge.</p></div>{bot?.status==='connected'&&<span className="pill">Connected</span>}</div>
          {bot?.status==='connected'?<><div className="connected-box"><ShieldCheck size={23}/><div><strong>@{bot.username}</strong><p>Your keys are encrypted on the server.</p></div></div><p className="field-note">This browser remembers your workspace. Closing the page keeps your Telegram bot running.</p><button className="text-button connection-action" disabled={!!busy} onClick={disconnect}>Disconnect Telegram</button></>:<form onSubmit={e=>{e.preventDefault();create();}}>
            {bot&&<p className="field-note">{bot.status==='created'?'Connection incomplete. Retry with the same bot token.':'Telegram is disconnected. Enter a bot token to reconnect.'} Your documents and NVIDIA key are still saved here.</p>}
            {config?.sharedKey&&<label className="checkbox-label"><input type="checkbox" checked={shared} onChange={e=>setShared(e.target.checked)}/>Use the teacher’s NVIDIA key</label>}
            {shared?<label>Classroom code<input type="password" value={code} onChange={e=>setCode(e.target.value)} placeholder={bot?'Optional: keep your saved key':'Provided by your teacher'} required={!bot} autoComplete="off"/></label>:<label>NVIDIA API key <a href="https://build.nvidia.com/" target="_blank" rel="noreferrer">Get a key ↗</a><input type="password" value={nvidiaKey} onChange={e=>setNvidiaKey(e.target.value)} placeholder={bot?'Optional: keep your saved key':'nvapi-…'} required={!bot} autoComplete="off"/></label>}
            <label>Telegram bot token <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">Open BotFather ↗</a><input type="password" value={telegramToken} onChange={e=>setTelegramToken(e.target.value)} placeholder="123456789:ABC…" required autoComplete="off"/></label><p className="field-note">Reuse your existing BotFather token. Create a bot with <code>/newbot</code> only if you do not have one.</p>
            <button className="primary wide" disabled={!!busy||!client}>{busy==='connection'?<><LoaderCircle className="spin" size={16}/>Verifying connections…</>:<>Create my workspace <ArrowRight size={16}/></>}</button>
          </form>}
          <details className="small-details"><summary>How do the connections work? <ChevronDown size={14}/></summary><p>Your NVIDIA key is checked against the chat and embedding endpoints. Your Telegram token connects your bot to this website. No AI model is trained here.</p></details>
        </section>
        <section className="card"><div className="card-heading"><span className={`step ${hasReady?'complete':''}`}>{hasReady?<Check size={15}/>:2}</span><div><h2>Add your knowledge</h2><p>Answers come from these documents only.</p></div></div><input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md" className="sr-only" onChange={e=>upload(e.target.files?.[0])}/>
          <button className="dropzone" disabled={!bot||!!busy} onClick={()=>fileInput.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(bot&&!busy)upload(e.dataTransfer.files[0]);}}><span className="upload-icon"><Upload size={22}/></span><strong>Choose a document</strong><span>or drag and drop it here</span><small>PDF, DOCX, TXT, MD · up to 5 MB</small></button>
          {!!busy&&!['connection','answer','pairing'].includes(busy)&&<p className="processing" role="status"><LoaderCircle className="spin" size={15}/>{busy}</p>}
          {!!docs.length&&<div className="document-list">{docs.map(doc=><div className="document-row" key={doc.id}><FileText size={19}/><div><strong>{doc.title}</strong><span>{doc.status==='ready'?'Ready for questions':'Processing · resume to finish'}</span></div>{doc.status!=='ready'&&<button className="text-button" disabled={!!busy} onClick={()=>resume(doc.id)}>Resume</button>}<button className="icon-button" aria-label={`Delete ${doc.title}`} disabled={!!busy} onClick={()=>remove(doc)}><Trash2 size={15}/></button></div>)}</div>}
          <p className="field-note">Text is split into chunks, embedded by NVIDIA, and stored in Supabase. Limit: {MAX_CHUNKS} chunks per workspace.</p>
        </section>
        <section className="card"><div className="card-heading"><span className={`step ${bot?.paired?'complete':''}`}>{bot?.paired?<Check size={15}/>:3}</span><div><h2>Take it to Telegram</h2><p>Pair one private chat with your assistant.</p></div></div>
          {pairUrl?<a className="primary wide no-margin" href={pairUrl} target="_blank" rel="noreferrer"><MessageCircle size={17}/>Open Telegram and press Start</a>:bot?.paired&&bot.status==='connected'?<><a className="secondary wide no-margin" href={`https://t.me/${bot.username}`} target="_blank" rel="noreferrer"><MessageCircle size={17}/>Open my Telegram bot</a><button className="text-button connection-action" disabled={!!busy} onClick={pair}>Change paired chat</button></>:<button className="secondary wide no-margin" disabled={bot?.status!=='connected'||!hasReady||!!busy} onClick={pair}>{busy==='pairing'?<LoaderCircle className="spin" size={16}/>:<MessageCircle size={17}/>} Connect Telegram</button>}
          <p className="field-note">{bot?.paired?'Your chat stays paired when you close the website or Telegram app.':'Only the paired chat can query your documents. After reconnecting from another workspace, pair your chat again.'}</p>
        </section>
      </div><section className="card answer-card"><div className="answer-heading"><div><span className="eyebrow">ANSWER PREVIEW</span><h2>Ask your documents</h2></div><span className={`status-dot ${canAsk?'active':''}`}>{sample?'Sample':hasReady?'Ready':'Waiting for document'}</span></div>
        {sample&&<div className="sample-strip"><FileText size={15}/><span>Sample College Handbook · fixed walkthrough</span><button onClick={()=>{setSample(false);setMessages([]);setNotice('');}}>Exit sample</button></div>}
        <div className="conversation" ref={scroll} aria-live="polite">{!messages.length&&<div className="chat-empty"><span className="empty-icon"><BookOpen size={30}/></span><h3>{canAsk?'Your knowledge, a question away.':'A conversation with your documents.'}</h3><p>{canAsk?'Ask a specific question. See the answer and the exact text that supports it.':'Connect your keys and upload a document to get started. Every answer will show its source.'}</p><div className="example-questions"><button disabled={!canAsk||!!busy} onClick={()=>ask('What is the attendance requirement?')}>What is the attendance requirement? <ArrowRight size={14}/></button><button disabled={!canAsk||!!busy} onClick={()=>ask('Who won the FIFA World Cup in 2018?')}>Try a question outside the document <ArrowRight size={14}/></button></div></div>}
          {messages.map((message,index)=><div className={`message ${message.role} ${message.error?'message-error':''}`} key={index}><span className="message-label">{message.role==='user'?'YOU':sample?'SAMPLE ASSISTANT':'YOUR ASSISTANT'}</span><p>{message.text}</p>{!!message.sources?.length&&<div className="sources">{message.sources.map((source,i)=><details key={i}><summary><FileText size={14}/>{source.title}{source.page?` · page ${source.page}`:''}<ChevronDown size={14}/></summary><blockquote>{source.quote}</blockquote></details>)}</div>}</div>)}
          {busy==='answer'&&<div className="thinking"><LoaderCircle className="spin" size={16}/>Searching documents and checking the evidence…</div>}
        </div><div className="chat-bottom"><form className="question-form" onSubmit={e=>{e.preventDefault();ask();}}><input aria-label="Question about your document" value={question} onChange={e=>setQuestion(e.target.value)} maxLength={1500} placeholder={canAsk?'Ask a question about your document…':'Upload a document to begin…'} disabled={!canAsk||!!busy}/><button aria-label="Send question" disabled={!canAsk||!question.trim()||!!busy}><Send size={18}/></button></form><p><ShieldCheck size={12}/>Evidence required. If it isn’t in your files, the assistant will say so.</p></div>
      </section></div>
      <footer><p>One link for the whole class. A separate workspace for each student.</p><span>Built with NVIDIA · Supabase · Telegram</span></footer>
      <details className="privacy-note"><summary>About your data and workspace</summary><p>Your browser remembers an anonymous workspace session. Use the same browser and profile to return. Closing this page does not disconnect your bot. Clearing site data, using private browsing or another browser creates a new workspace; reconnect your existing Telegram bot instead of creating another one. Reconnecting moves only the Telegram connection: earlier documents and NVIDIA keys stay private in their earlier workspace. The host stores extracted text and encrypted API keys in Supabase. Relevant document excerpts and questions are sent to NVIDIA; Telegram receives bot messages. Use documents you have permission to share. Responses can still be mistaken—check the quoted evidence.</p></details>
    </main>
    {replace&&<div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="replace-heading"><h2 id="replace-heading">{replace==='workspace'?'Reconnect this bot here?':'Replace this bot’s connection?'}</h2><p>{replace==='workspace'?'You can reuse this bot and token. Its Telegram connection will move from the earlier workspace to this one. Earlier documents and keys stay private there; upload your documents here and pair your private chat again.':'This bot is connected to another website. Replacing its connection will move it to this website.'}</p><div><button className="secondary" disabled={!!busy} onClick={()=>{setReplace(null);setReconnect(false);}}>Cancel</button><button className="primary" disabled={!!busy} onClick={()=>create(replace==='website',replace==='workspace')}>{replace==='workspace'?'Reconnect this bot here':'Replace connection'}</button></div></div></div>}
  </div>;
}
