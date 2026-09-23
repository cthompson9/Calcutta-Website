import { packager } from '@electron/packager';
import { fileURLToPath } from 'node:url';
export const options={
  dir:fileURLToPath(new URL('./',import.meta.url)),out:'out',name:'Calcutta Listener',
  platform:process.platform,arch:process.arch,
  extraResource:[fileURLToPath(new URL('../server',import.meta.url)),fileURLToPath(new URL('../web',import.meta.url))],
  // Native SDK helpers and bundled GStreamer must be real executable files.
  asar:false,prune:true,ignore:[/^\/out($|\/)/,/^\/test($|\/)/,/^\/\.local($|\/)/],
  extendInfo:{NSMicrophoneUsageDescription:'Listen to spoken auction results.',NSAudioCaptureUsageDescription:'Listen to auction audio from your computer speakers.'},
};
if(process.argv[1]===fileURLToPath(import.meta.url))await packager(options);
