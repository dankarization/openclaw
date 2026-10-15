import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const root='/home/dankar/openclaw-pr-qa-20261014',run=root+'/groups-proof-20261015/live';
Object.assign(process.env,{OPENCLAW_STATE_DIR:run+'/state',OPENCLAW_CONFIG_PATH:run+'/openclaw.json'});
const {GatewayClient}=await import(root+'/android-lane/src/gateway/client.ts');
const token=(await fs.readFile(run+'/admin.token','utf8')).trim();
let client;await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('connect timeout')),25000);client=new GatewayClient({url:'ws://127.0.0.1:18943',token,clientName:'cli',mode:'cli',requestTimeoutMs:120000,scopes:['operator.admin','operator.read','operator.write','operator.pairing'],onHelloOk:()=>{clearTimeout(t);resolve()},onConnectError:e=>{clearTimeout(t);reject(e)}});client.start()});
const receipt={kind:'actual-Android-put-and-native-device-token-revoke-serialized-through-one-writer',startedAt:new Date().toISOString(),productPatched:false};
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
 const identity=JSON.parse(await fs.readFile(run+'/android-identity.private.json','utf8'));
 receipt.revokeRequestedAt=new Date().toISOString();let revokeSettled=false;
 const revoke=client.request('device.token.revoke',{deviceId:identity.deviceId,role:'operator'}).then(r=>{revokeSettled=true;receipt.revokeCompletedAt=new Date().toISOString();return r});
 await new Promise(r=>setTimeout(r,1000));
 receipt.revokeSettledWhileCatalogWorkerPaused=revokeSettled;
 receipt.resume=await control('resume',true);receipt.resumedAt=new Date().toISOString();
 receipt.revokeResult=await revoke;
 receipt.after=await client.request('sessions.groups.list',{});
 receipt.newNamePresent=receipt.after.groups.some(g=>g.name==='QAREVOKE');
 receipt.relayAfterRevoke=await(await fetch('http://127.0.0.1:18946/status')).json();
 receipt.serializedOutcome=receipt.revokeSettledWhileCatalogWorkerPaused===false&&receipt.newNamePresent&&!!receipt.revokeCompletedAt;
 receipt.finishedAt=new Date().toISOString();
 await fs.writeFile(run+'/final-effect-native-revoke-receipt.private.json',JSON.stringify(receipt,null,2));
 console.log(JSON.stringify({pausedStage:paused.stage,revokeSettledWhilePaused:receipt.revokeSettledWhileCatalogWorkerPaused,catalogWritePrecedesCompletedRevoke:receipt.newNamePresent,revokeCompletedAt:receipt.revokeCompletedAt,relayPeers:receipt.relayAfterRevoke.peers,startedAt:receipt.startedAt,finishedAt:receipt.finishedAt}));
 if(!receipt.serializedOutcome)throw Error('Unexpected native serialized outcome');
}finally{
 await control('resume',true).catch(()=>{});
 await fs.writeFile(run+'/final-effect-native-revoke-receipt.private.json',JSON.stringify(receipt,null,2));
 await client.stopAndWait();
}

