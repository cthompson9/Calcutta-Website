const $=id=>document.getElementById(id);
let state,editing=null,captureState={status:'idle'},lotsFilled=false;
function renderWebsite(s) {
  const paired=!!s.auction;
  document.querySelector('.badge').textContent=paired?'WEBSITE CONNECTED':'LOCAL REHEARSAL';
  document.querySelector('.notice').textContent=paired
    ? `${s.auction.name} · ${s.message||'Connected'}${s.pending?` · ${s.pending} events waiting`:''}. Run bidding and corrections in the website.`
    : 'Practice results stay on this computer. Open this listener from your website’s Auction tab to connect.';
  // The local rehearsal interpreter must never masquerade as the hosted auction.
  for(const el of document.querySelectorAll('.columns, section.card, details.card')) el.hidden=paired;
  if(paired){$('status-detail').textContent=s.connected?'Ready to send speech to this auction.':'Connection expired. Reopen from the Auction tab.';}
}
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:cents%100?2:0}).format(cents/100);
async function api(path,data) {
  const r=await fetch(path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
  const body=await r.json();if(!r.ok)throw new Error(body.error||'Could not reach the local backend.');return body;
}
function error(message){$('error').textContent=message;$('error').hidden=!message;}
function node(tag,text,className){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;}
function render(next) {
  state=next;
  $('current').textContent=state.lots.find(l=>l.id===state.currentLotId)?.name??'Name the next lot';
  $('remaining').textContent=`${state.lots.length-state.sales.length} of ${state.lots.length} lots available`;
  $('count').textContent=state.sales.length;$('total').textContent=money(state.sales.reduce((n,s)=>n+s.priceCents,0));
  $('empty').hidden=!!state.sales.length;
  $('results').replaceChildren(...state.sales.map((sale,i)=>{
    const tr=node('tr');tr.append(node('td',String(i+1)),node('td',state.lots.find(l=>l.id===sale.lotId)?.name));
    const owners=node('td',sale.owners.map(o=>`${o.name}${o.basisPoints===null?'':` (${o.basisPoints/100}%)`}`).join(' / '));
    if(sale.needsShares)owners.append(node('br'),node('span','Set ownership shares','warn'));
    tr.append(owners,node('td',money(sale.priceCents)));
    const cell=node('td'),button=node('button','Edit','secondary');button.setAttribute('aria-label',`Edit ${state.lots.find(l=>l.id===sale.lotId)?.name}`);button.onclick=()=>openEditor(sale);cell.append(button);tr.append(cell);return tr;
  }));
  $('transcript').replaceChildren(...(state.transcript.length?state.transcript.map(t=>{const a=node('article',t.text,t.final?'':'partial');a.append(node('p',`${t.source} · ${new Date(t.receivedAt).toLocaleTimeString()}`));return a;}):[node('p','Waiting for speech.','muted')]));
  const reviews=state.pendingAnnouncement?[{text:state.pendingAnnouncement,reason:'Incomplete announcement. Waiting for the remaining words, or use Add a result.'},...state.reviews]:state.reviews;
  $('reviews').replaceChildren(...(reviews.length?reviews.map(r=>{const a=node('article',r.text);a.append(node('p',r.reason));return a;}):[node('p','No unresolved announcements.','muted')]));
  const last=state.uploads.at(-1);$('recording-status').textContent=last?`Recall recording: ${last.status.replaceAll('_',' ')}`:'No recording started.';
  if(!lotsFilled){$('lots').value=state.lots.map(l=>[l.name,...l.aliases].join(' | ')).join('\n');lotsFilled=true;}
}
function renderCapture(s) {
  captureState=s;
  $('status').textContent=({idle:'Ready to rehearse',starting:'Starting…',recording:'Listening',stopped:'Recording stopped',permission:'Audio permission needed',warning:'Check the listener',error:'Recorder needs attention'})[s.status]??s.status;
  $('status-detail').textContent=s.message??'';
  $('indicator').classList.toggle('active',s.status==='recording');
  $('start').disabled=s.recording || s.status==='starting';
  $('stop').disabled=!s.recording;
  $('permission').hidden=s.status!=='permission';
}
function openEditor(sale=null){editing=sale;$('edit-title').textContent=sale?'Edit result':'Add a result';$('edit-error').textContent='';$('edit-lot').replaceChildren(...state.lots.map(l=>{const o=node('option',l.name);o.value=l.id;return o;}));$('edit-lot').value=sale?.lotId??state.currentLotId??state.lots[0].id;$('edit-price').value=sale?sale.priceCents/100:'';$('edit-owners').value=sale?sale.owners.map(o=>`${o.name}, ${o.basisPoints===null?'':o.basisPoints/100}`).join('\n'):'';$('editor').showModal();}
$('add').onclick=()=>openEditor();$('cancel-edit').onclick=()=>$('editor').close();
$('edit-form').onsubmit=async e=>{e.preventDefault();try{
  const owners=$('edit-owners').value.trim().split('\n').map(line=>{const at=line.lastIndexOf(',');if(at<0)throw new Error('Use “Name, percentage” on each line.');const percent=line.slice(at+1).trim();if(!/^\d+(?:\.\d{1,2})?$/.test(percent))throw new Error('Use percentages with up to two decimal places.');return{name:line.slice(0,at).trim(),basisPoints:Math.round(Number(percent)*100)};});
  await api('/api/result',{saleId:editing?.id,expectedRevision:editing?.revision,lotId:$('edit-lot').value,priceCents:Math.round(Number($('edit-price').value)*100),owners});$('editor').close();
}catch(e){$('edit-error').textContent=e.message;}};
$('practice').onsubmit=async e=>{e.preventDefault();try{await api('/api/rehearse',{text:$('announcement').value});$('announcement').value='';error('');}catch(e){error(e.message);}};
$('new').onclick=async()=>{if(!confirm('Archive these practice results and start a fresh rehearsal?'))return;try{const lots=$('lots').value.split('\n').filter(s=>s.trim()).map(line=>{const [name,...aliases]=line.split('|').map(s=>s.trim());return{name,aliases};});await api('/api/session',{lots});error('');}catch(e){error(e.message);}};
async function init(){
  const token=location.hash.slice(1);if(token){history.replaceState(null,'','/');await api('/api/auth',{token});}
  const initial=await api('/api/state');render(initial);
  const events=new EventSource('/api/events');events.onmessage=e=>render(JSON.parse(e.data));events.onerror=()=>error('Board connection interrupted. It will reconnect automatically.');events.onopen=()=>error('');
  if(window.capture){
    window.capture.onWebsite(renderWebsite);renderWebsite(await window.capture.websiteStatus());
    window.capture.onStatus(renderCapture);renderCapture(await window.capture.status());
    $('start').onclick=async()=>{try{renderCapture(await window.capture.start());}catch{error('Could not reach the desktop recorder.');}};
    $('stop').onclick=async()=>{try{renderCapture(await window.capture.stop());}catch{error('Could not stop the recorder.');}};
    $('permission').onclick=()=>window.capture.permissions(captureState.permission);
    $('open-board').hidden=false;$('open-board').onclick=()=>window.capture.openBoard();
  }else{
    $('start').disabled=true;$('status').textContent='Live local board';$('status-detail').textContent='Use the Calcutta desktop window to start and stop audio. Typed practice works here.';
  }
  if(!initial.recallConfigured)error('Recall is not configured yet. Typed rehearsal still works.');
}
init().catch(e=>error(e.message));
