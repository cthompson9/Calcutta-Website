import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(new URL('./desktop/package.json',import.meta.url));
try {
  const electron=require('electron');
  const desktop=fileURLToPath(new URL('./desktop/',import.meta.url));
  const env={...process.env};
  delete env.CALCUTTA_CONNECTION_FILE;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RECALL_API_KEY;
  delete env.RECALL_WEBHOOK_VERIFICATION_SECRET;
  const args=process.argv.slice(2).filter(arg=>arg==='--register-protocol' || arg.startsWith('calcutta-listener://'));
  const child=spawn(electron,[desktop,...args],{env,stdio:'ignore',windowsHide:false});
  child.on('error',()=>{console.error('Could not open the desktop listener.');});
} catch {
  console.error('Could not launch. Close any existing listener, or run the desktop dependency setup first.');
  process.exitCode=1;
}
