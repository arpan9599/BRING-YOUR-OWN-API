import {createClient,type SupabaseClient} from '@supabase/supabase-js';

let opening:Promise<SupabaseClient>|null=null;

// Reuse initialization across React remounts. Serialize first sign-in across tabs
// where Web Locks are available; ordinary reloads reuse Supabase's saved session.
export function openWorkspace(url:string,key:string):Promise<SupabaseClient>{
  if(!opening){
    opening=(async()=>{
      const client=createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'docbot-workspace'}});
      const restore=async()=>{
        const existing=await client.auth.getSession();if(existing.error)throw existing.error;
        if(!existing.data.session){const result=await client.auth.signInAnonymously();if(result.error)throw new Error('Ask the host to enable anonymous sign-ins and check the campus IP rate limit.');}
      };
      if(typeof navigator!=='undefined'&&navigator.locks)await navigator.locks.request('docbot-workspace-initialization',restore);
      else await restore();
      return client;
    })().catch(error=>{opening=null;throw error;});
  }
  return opening;
}
