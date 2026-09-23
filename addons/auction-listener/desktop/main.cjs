const {app,BrowserWindow,ipcMain,shell,dialog}=require('electron');
const {readFileSync,writeFileSync,renameSync,existsSync,appendFileSync}=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const resourceRoot=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'..');
const {PROTOCOL,findLaunchLink}=require(path.join(resourceRoot,'server','launch-link.cjs'));
const trace=stage=>{if(process.env.CALCUTTA_CONNECTION_FILE)appendFileSync(path.join(path.dirname(process.env.CALCUTTA_CONNECTION_FILE),'desktop-startup.log'),`${new Date().toISOString()} ${stage}\n`);};
trace('desktop-module-loaded');
const sdk=require('@recallai/desktop-sdk');
const {CaptureController}=require('./controller.cjs');
if(!app.requestSingleInstanceLock()) app.exit(0);
let window,controller,closing=false,timer,backend,api,pairing=false;
let pendingLink=findLaunchLink(process.argv);
async function connectWebsite(raw) {
  if(!raw)return;
  if(!api || !window){pendingLink=raw;return;}
  if(pairing)return;
  pairing=true;
  try {
    if(controller.active || controller.busy || controller.queue.length)throw new Error('Stop recording and deliver pending transcripts before switching auctions.');
    const state=await api('/api/website/pair',{url:raw});
    window.webContents.send('website:state',state);
    window.setTitle(`Calcutta Listener — ${state.auction.name}`);
  } catch(error) {dialog.showErrorBox('Connect to auction',error.message);}
  finally {pairing=false;}
}
app.on('second-instance',(_event,args)=>{
  if(window){if(window.isMinimized())window.restore();window.show();window.focus();}
  void connectWebsite(findLaunchLink(args));
});
app.on('open-url',(event,url)=>{event.preventDefault();void connectWebsite(url);});
app.whenReady().then(async()=>{
  trace('electron-ready');
  let file=process.env.CALCUTTA_CONNECTION_FILE;
  if(!file) {
    const {startBackend}=await import(pathToFileURL(path.join(resourceRoot,'server','main.mjs')).href);
    backend=await startBackend({dataDir:app.isPackaged?path.join(app.getPath('userData'),'private'):path.join(resourceRoot,'.local')});
    file=backend.connectionPath;
  }
  if(process.argv.includes('--register-protocol')) {
    const registered=app.isPackaged?app.setAsDefaultProtocolClient(PROTOCOL):app.setAsDefaultProtocolClient(PROTOCOL,process.execPath,[path.resolve(__dirname)]);
    if(!registered)throw new Error('Windows could not register the listener.');
  }
  const connection=JSON.parse(readFileSync(file,'utf8'));
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.url) || !/^https:\/\/(?:us-west-2|us-east-1|eu-central-1|ap-northeast-1)\.recall\.ai$/.test(connection.apiUrl)) throw new Error('Invalid local connection.');
  api=async(route,body)=>{
    const response=await fetch(`${connection.url}${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    const data=await response.json();if(!response.ok) throw new Error(data.error||'Request failed.');return data;
  };
  const queuePath=path.join(path.dirname(file),'transcript-outbox.json');
  controller=new CaptureController({sdk,api,apiUrl:connection.apiUrl,openSettings:url=>shell.openExternal(url),
    onState:state=>{if(window && !window.isDestroyed())window.webContents.send('capture:state',state);},
    readQueue:()=>existsSync(queuePath)?JSON.parse(readFileSync(queuePath,'utf8')):[],
    writeQueue:queue=>{writeFileSync(`${queuePath}.tmp`,JSON.stringify(queue),{mode:0o600});renameSync(`${queuePath}.tmp`,queuePath);},
  });
  window=new BrowserWindow({width:1180,height:860,minWidth:760,minHeight:600,title:'Calcutta Listener — Rehearsal',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  trace('window-created');
  window.webContents.on('did-fail-load',(_e,code)=>trace(`page-load-failed-${code}`));
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==connection.url)event.preventDefault();});
  const allowed=event=>{if(event.sender!==window.webContents || new URL(event.senderFrame.url).origin!==connection.url)throw new Error('Unauthorized window.');};
  ipcMain.handle('capture:start',async event=>{allowed(event);await controller.start();return controller.state;});
  ipcMain.handle('capture:stop',async event=>{allowed(event);await controller.stop();return controller.state;});
  ipcMain.handle('capture:status',event=>{allowed(event);return controller.state;});
  ipcMain.handle('capture:permissions',async(event,p)=>{allowed(event);await controller.fixPermission(p);});
  ipcMain.handle('capture:board',async event=>{allowed(event);await shell.openExternal(`${connection.url}/#${connection.token}`);});
  ipcMain.handle('website:status',async event=>{allowed(event);return api('/api/website');});
  await window.loadURL(`${connection.url}/#${connection.token}`);
  trace('page-loaded');
  window.show();
  if(pendingLink){const link=pendingLink;pendingLink=null;await connectWebsite(link);}
  else window.webContents.send('website:state',await api('/api/website'));
  timer=setInterval(async()=>{
    await controller.flush();
    const website=await api('/api/website/tick',{recording:!!controller.active}).catch(()=>null);
    if(website && window && !window.isDestroyed())window.webContents.send('website:state',website);
    const state=await api('/api/state').catch(()=>null);
    for(const upload of state?.uploads??[]) {
      if(upload.id && ['recording_ended','uploading'].includes(upload.status)) await api('/api/reconcile',{id:upload.id}).catch(()=>{});
    }
  },10000);
  window.on('close',event=>{
    if(closing)return;
    event.preventDefault();
    void(async()=>{
      if(controller.active || controller.busy || controller.queue.length) {
        const choice=await dialog.showMessageBox(window,{type:'question',buttons:['Keep listening','Stop and close'],defaultId:0,cancelId:0,message:'Stop the recorder before closing?',detail:'Any undelivered transcript remains saved on this computer.'});
        if(choice.response!==1 || controller.busy)return;
        await controller.stop();if(controller.active)return;
      }
      clearInterval(timer);
      if(controller.initialized)await sdk.shutdown().catch(()=>{});
      closing=true;window.close();
    })();
  });
}).catch(()=>{trace('startup-failed');dialog.showErrorBox('Calcutta listener','The listener could not start. Close any existing copy and launch it again.');app.quit();});
app.on('window-all-closed',()=>{if(backend){backend.server.closeAllConnections();backend.server.close();}app.quit();});
