const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capture',{
  start:()=>ipcRenderer.invoke('capture:start'),
  stop:()=>ipcRenderer.invoke('capture:stop'),
  status:()=>ipcRenderer.invoke('capture:status'),
  permissions:p=>ipcRenderer.invoke('capture:permissions',p),
  onStatus:callback=>{ipcRenderer.on('capture:state',(_event,state)=>callback(state));},
  websiteStatus:()=>ipcRenderer.invoke('website:status'),
  onWebsite:callback=>{ipcRenderer.on('website:state',(_event,state)=>callback(state));},
});
