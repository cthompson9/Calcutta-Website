import {useEffect, useRef, useState} from 'react';

// Mount with key={auctionId}; caller supplies the existing in-memory admin key.
export function ListenerConnect({auctionId,adminKey}:{auctionId:string;adminKey:string}) {
  const [link,setLink]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('Listener not connected');
  const generation=useRef(0);
  useEffect(()=>{
    const version=++generation.current;
    const controller=new AbortController();
    setLink(null);setBusy(false);setError('');setStatus('Checking listener…');
    let timeout:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const response=await fetch(`/api/listener/status?auctionId=${encodeURIComponent(auctionId)}`,{
          headers:{Authorization:`Bearer ${adminKey}`},cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('Listener status unavailable');
        const state=await response.json();
        if(generation.current===version)setStatus(state.connected?(state.recording?'Recording':'Listener connected — click Start listening in its window'):'Listener not connected');
      } catch {if(generation.current===version)setStatus('Listener status unavailable');}
      if(!controller.signal.aborted)timeout=setTimeout(poll,5000);
    };
    void poll();
    return()=>{generation.current++;controller.abort();clearTimeout(timeout);};
  },[auctionId,adminKey]);
  async function openListener() {
    const version=generation.current;
    setBusy(true);setError('');setLink(null);
    try {
      const response=await fetch('/api/listener/tickets',{method:'POST',headers:{Authorization:`Bearer ${adminKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({auctionId}),cache:'no-store'});
      if(!response.ok)throw new Error('Could not connect. Confirm this auction is open and try again.');
      const result=await response.json();
      const parsed=new URL(result.launchUrl);
      if(parsed.protocol!=='calcutta-listener:' || parsed.hostname!=='connect')throw new Error('Invalid listener link.');
      if(generation.current!==version)return;
      setLink(result.launchUrl);
      // Explicit button initiated this request. Browsers may still ask to open the app.
      window.location.assign(result.launchUrl);
    } catch(e) {if(generation.current===version)setError(e instanceof Error?e.message:'Could not open listener.');}
    finally {if(generation.current===version)setBusy(false);}
  }
  return <section className="rounded-lg border border-border p-4 space-y-2" aria-label="Auction listener">
    <h3 className="font-semibold">Calcutta Listener</h3>
    <p role="status">{status}</p>
    <button type="button" onClick={()=>void openListener()} disabled={busy} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
      {busy?'Connecting…':'Open Calcutta Listener'}
    </button>
    {link && <p>If the app did not open, <a href={link} rel="noreferrer" className="underline">open the listener</a>. Allow your browser to open Calcutta Listener. Links expire after 90 seconds; click the button again for a fresh link.</p>}
    <p className="text-sm text-muted-foreground">Install the Calcutta Listener once on this computer. Recording starts only when you click Start listening in its window.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
