const { randomUUID } = require('node:crypto');
const settingsUrls={
  microphone:'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility:'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'system-audio':'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};
function transcriptPayload(event) {
  if (!['transcript.data','transcript.partial_data'].includes(event.event)) return null;
  let data=event.data;
  for(let i=0;i<4 && !Array.isArray(data?.words);i++) data=data?.data;
  if(!Array.isArray(data?.words)) throw new Error('Unexpected Recall transcript format.');
  return {event:event.event,data:{data}};
}
class CaptureController {
  constructor({sdk,api,apiUrl,platform=process.platform,openSettings,onState=()=>{},readQueue=()=>[],writeQueue=()=>{}}) {
    Object.assign(this,{sdk,api,apiUrl,platform,openSettings,onState,writeQueue});
    this.queue=readQueue();this.windows=new Map();this.permissions={};this.active=null;this.busy=false;this.initialized=false;this.sending=false;
    this.state={status:'idle',message:'Ready for a rehearsal.'};
  }
  update(status,message,extra={}) {this.state={status,message,recording:!!this.active,...extra};this.onState(this.state);}
  async init() {
    if(this.initialized) return;
    this.sdk.addEventListener('permission-status',e=>{this.permissions[e.permission]=e.status;});
    this.sdk.addEventListener('realtime-event',e=>{
      const recording=this.windows.get(e.window?.id); if(!recording) return;
      try {
        const event=transcriptPayload(e);if(!event) return;
        this.queue.push({id:randomUUID(),sessionId:recording.sessionId,uploadId:recording.id,websiteSessionId:recording.websiteSessionId,event});
        this.writeQueue(this.queue);void this.flush();
      } catch {this.update('error','A transcript could not be read or saved. Stop and check the listener.');}
    });
    this.sdk.addEventListener('network-status',e=>{
      if(e.status==='disconnected') this.update('warning','Connection lost. Results may be delayed; keep the app open.');
      else {void this.flush();this.update(this.active?'recording':'idle','Connection restored.');}
    });
    this.sdk.addEventListener('error',()=>this.update('error','The audio recorder reported an error. Stop recording and try again.'));
    this.sdk.addEventListener('recording-ended',e=>{
      const recording=this.windows.get(e.window?.id);
      if(!recording)return;
      if(this.active?.windowId===e.window.id)this.active=null;
      void this.api('/api/upload-status',{id:recording.id,status:'recording_ended'}).catch(()=>{});
      this.update('stopped','Recording ended. Recall is finishing the upload.');
    });
    this.sdk.addEventListener('media-capture-status',e=>{
      if(e.type==='audio' && !e.capturing && this.active?.windowId===e.window?.id) this.update('warning','Audio capture stopped. Check the microphone and speaker selection.');
    });
    await this.sdk.init({apiUrl:this.apiUrl,acquirePermissionsOnStartup:[]});
    this.initialized=true;
  }
  async start() {
    if(this.busy || this.active) return;
    this.busy=true;
    this.update('starting','Preparing the microphone and computer audio…');
    let upload;
    try {
      await this.init();
      for(const p of ['accessibility','microphone','system-audio']) {
        await this.sdk.requestPermission(p);
        if(this.platform==='darwin') {
          for(let i=0;i<60 && this.permissions[p]===undefined;i++) await new Promise(r=>setTimeout(r,100));
          if(this.permissions[p]!=='granted') {
            this.update('permission','Allow audio access in System Settings, then click Start listening again.',{permission:p});return;
          }
        }
      }
      const windowId=await this.sdk.prepareDesktopAudioRecording();
      upload=await this.api('/api/uploads',{});
      const recording={id:upload.id,sessionId:upload.sessionId,websiteSessionId:upload.websiteSessionId,windowId};
      this.windows.set(windowId,recording);
      await this.sdk.startRecording({windowId,uploadToken:upload.uploadToken});
      this.active=recording;
      await this.api('/api/upload-status',{id:upload.id,status:'recording_started'});
      this.update('recording','Listening to microphone and computer audio.');
    } catch {
      if(upload) {
        const recording=[...this.windows.values()].find(r=>r.id===upload.id);
        if(recording)await this.sdk.stopRecording({windowId:recording.windowId}).catch(()=>{});
        this.active=null;
        await this.api('/api/upload-status',{id:upload.id,status:'failed'}).catch(()=>{});
      }
      this.update('error','Could not start recording. Check Recall access, your connection, and audio devices.');
    } finally {this.busy=false;}
  }
  async stop() {
    if(this.busy || !this.active) return;
    this.busy=true;const active=this.active;
    try {
      await this.sdk.stopRecording({windowId:active.windowId});
      this.active=null;
      await this.api('/api/upload-status',{id:active.id,status:'recording_ended'});
      await this.flush();
      this.update('stopped','Stopped. Recall is finishing the upload; keep this window open briefly.');
    } catch {this.update('error','Could not confirm recording stopped. Try Stop again before closing.');}
    finally {this.busy=false;}
  }
  async flush() {
    if(this.sending) return;
    this.sending=true;
    try {
      while(this.queue.length) {
        await this.api('/api/transcript',this.queue[0]);
        this.queue.shift();this.writeQueue(this.queue);
      }
    } catch {this.update('warning','A transcript is waiting to reach the local board. It is saved for retry.');}
    finally {this.sending=false;}
  }
  async fixPermission(permission) {
    const url=this.platform==='win32'?'ms-settings:privacy-microphone':settingsUrls[permission];
    if(!url) throw new Error('Unknown permission.');
    await this.openSettings(url);
  }
}
module.exports={CaptureController,transcriptPayload};
