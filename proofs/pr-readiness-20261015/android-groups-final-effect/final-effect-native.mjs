import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const root='/home/dankar/openclaw-pr-qa-20261014',run=root+'/groups-proof-20261015/live';
Object.assign(process.env,{OPENCLAW_STATE_DIR:run+'/state',OPENCLAW_CONFIG_PATH:run+'/openclaw.json'});
const {GatewayClient}=await import(root+'/android-lane/src/gateway/client.ts');
const token=(await fs.readFile(run+'/admin.token','utf8')).trim();
let client;await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('connect timeout')),25000);client=new GatewayClient({url:'ws://127.0.0.1:18943',token,clientName:'cli',mode:'cli',requestTimeoutMs:120000,scopes:['operator.admin','operator.read','operator.write','operator.pairing'],onHelloOk:()=>{clearTimeout(t);resolve()},onConnectError:e=>{clearTimeout(t);reject(e)}});client.start()});
const receipt={kind:'actual-Android-put-physical-disconnect-before-native-worker-commit',startedAt:new Date().toISOString(),productPatched:false};
const control=async(path,post=false)=>await(await fetch('http://127.0.0.1:18948/'+path,post?{method:'POST'}:undefined)).json();
const adb=root+'/android-tools/sdk/platform-tools/adb';
try{
 receipt.before=await client.request('sessions.groups.list',{});
 receipt.arm=await control('arm',true);
 if(!receipt.arm.located)throw Error('No actual native worker admission location');
 receipt.uiTapAt=new Date().toISOString();
 execFileSync(adb,['-s','emulator-5560','shell','input','tap','804','985']);
 let paused;
 for(let i=0;i<80;i++){
  const s=await control('status');
  paused=s.sessions.find(x=>x.paused&&x.stage==='commit');
  if(paused){receipt.pause={session:paused,events:s.events};break}
  await new Promise(r=>setTimeout(r,100));
 }
 if(!paused)throw Error('Actual native catalog commit not paused');
 receipt.forceStopAt=new Date().toISOString();
 execFileSync(adb,['-s','emulator-5560','shell','am','force-stop','ai.openclaw.app.debug']);
 for(let i=0;i<40;i++){
  const s=await(await fetch('http://127.0.0.1:18946/status')).json();
  if(!s.peers.some(p=>p.role==='operator'&&p.connected)){receipt.physicalSocketClosedAt=new Date().toISOString();receipt.relayAfterStop=s;break}
  await new Promise(r=>setTimeout(r,50));
 }
 if(!receipt.physicalSocketClosedAt)throw Error('Actual physical socket still live');
 receipt.resume=await control('resume',true);
 receipt.resumedAt=new Date().toISOString();
 receipt.after=await client.request('sessions.groups.list',{});
 receipt.catalogUnchanged=JSON.stringify(receipt.before)===JSON.stringify(receipt.after);
 receipt.newNameAbsent=!receipt.after.groups.some(g=>g.name==='QACOMMIT');
 receipt.finishedAt=new Date().toISOString();
 await fs.writeFile(run+'/final-effect-disconnect-receipt.private.json',JSON.stringify(receipt,null,2));
 console.log(JSON.stringify({pausedStage:paused.stage,physicalSocketClosed:!!receipt.physicalSocketClosedAt,catalogUnchanged:receipt.catalogUnchanged,newNameAbsent:receipt.newNameAbsent,startedAt:receipt.startedAt,finishedAt:receipt.finishedAt}));
 if(!receipt.catalogUnchanged||!receipt.newNameAbsent)throw Error('Write survived revoked physical request');
}finally{
 await control('resume',true).catch(()=>{});
 await fs.writeFile(run+'/final-effect-disconnect-receipt.private.json',JSON.stringify(receipt,null,2));
 await client.stopAndWait();
}

