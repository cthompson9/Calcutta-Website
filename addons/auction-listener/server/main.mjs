import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuctionStore } from './store.mjs';
import { RecallClient, readRecallConfig } from './recall.mjs';
import { createAuctionServer } from './http.mjs';
import { WebsiteBridge } from './bridge.mjs';

export async function startBackend({ dataDir=fileURLToPath(new URL('../.local/',import.meta.url)), port=43127, env=process.env, fetcher=fetch }={}) {
  mkdirSync(dataDir,{recursive:true});
  const configPath=resolve(dataDir,'backend-config.json');
  const privateConfig=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
  const config=readRecallConfig({...privateConfig,...env});
  const token=randomBytes(32).toString('hex');
  const store=new AuctionStore(resolve(dataDir,'auction.json'));
  const recall=new RecallClient(config,fetcher);
  const bridge=new WebsiteBridge({file:resolve(dataDir,'website-bridge.json'),fetcher,
    ...(Array.isArray(privateConfig.CALCUTTA_WEBSITE_ORIGINS)?{allowedOrigins:privateConfig.CALCUTTA_WEBSITE_ORIGINS}:{})});
  const server=createAuctionServer({store,recall,token,bridge});
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});
  if(store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) {
    store.change(s=>{for(const u of s.uploads)if(['ready','recording_started'].includes(u.status))u.status='interrupted';});
  }
  const connection={url:`http://127.0.0.1:${server.address().port}`,token,apiUrl:config.apiUrl};
  const connectionPath=resolve(dataDir,'connection.json');
  writeFileSync(connectionPath,JSON.stringify(connection),{mode:0o600});
  return {server,store,connection,connectionPath};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  startBackend().then(({connection})=>console.log(`Calcutta rehearsal backend ready at ${connection.url}. Use the launcher to open it.`)).catch(()=>{console.error('Could not start the local backend. Another listener may already be running.');process.exitCode=1;});
}
