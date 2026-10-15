import fs from 'node:fs/promises';import {execFileSync} from 'node:child_process';
const root='/home/dankar/openclaw-pr-qa-20261014',run=root+'/groups-proof-20261015/live';
Object.assign(process.env,{OPENCLAW_STATE_DIR:run+'/state',OPENCLAW_CONFIG_PATH:run+'/openclaw.json'});
const {GatewayClient}=await import(root+'/android-lane/src/gateway/client.ts');
const token=(await fs.readFile(run+'/admin.token','utf8')).trim();let client;
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('connect timeout')),25000);client=new GatewayClient({url:'ws://127.0.0.1:18943',token,clientName:'cli',mode:'cli',requestTimeoutMs:120000,scopes:['operator.admin','operator.read','operator.write','operator.pairing'],onHelloOk:()=>{clearTimeout(timer);resolve()},onConnectError:e=>{clearTimeout(timer);reject(e)}});client.start()});
const control=async(path,post=false)=>await(await fetch('http://127.0.0.1:18946/'+path,post?{method:'POST',body:'{}'}:undefined)).json();
const adb=root+'/android-tools/sdk/platform-tools/adb',receipt={kind:'real-Android-process-retirement-same-endpoint-physical-replacement',startedAt:new Date().toISOString()};
try{
 receipt.before=await client.request('sessions.groups.list',{});
 const beforeStatus=await control('status');receipt.oldOperator=beforeStatus.peers.find(p=>p.role==='operator'&&p.connected);if(!receipt.oldOperator)throw Error('No actual Android operator');
 await control('hold-next-groups-list',true);
 execFileSync(adb,['-s','emulator-5560','shell','input','tap','804','985']);
 for(let i=0;i<50;i++){if((await control('status')).held){receipt.heldAt=new Date().toISOString();break}await new Promise(r=>setTimeout(r,50));}
 if(!receipt.heldAt)throw Error('Actual UI list response not held');
 execFileSync(adb,['-s','emulator-5560','shell','am','force-stop','ai.openclaw.app.debug']);
 receipt.oldOwnerStoppedAt=new Date().toISOString();
 execFileSync(adb,['-s','emulator-5560','shell','am','start','-n','ai.openclaw.app.debug/ai.openclaw.app.MainActivity'],{stdio:'pipe'});
 for(let i=0;i<120;i++){const s=await control('status');const p=s.peers.find(p=>p.role==='operator'&&p.connected&&p.peerId!==receipt.oldOperator.peerId);if(p){receipt.newOperator=p;receipt.newPhysicalAuthenticatedAt=new Date().toISOString();break}await new Promise(r=>setTimeout(r,100));}
 if(!receipt.newOperator)throw Error('Replacement physical connection absent');
 receipt.release=await control('release',true);receipt.releasedAt=new Date().toISOString();
 receipt.after=await client.request('sessions.groups.list',{});
 receipt.catalogUnchanged=JSON.stringify(receipt.before)===JSON.stringify(receipt.after);
 const es=(await fs.readFile(run+'/relay-negative-events.ndjson','utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.ts>=receipt.startedAt);
 receipt.actualMutationRequests=es.filter(e=>e.event==='android-request'&&(e.method==='sessions.groups.put'||e.method==='sessions.patch')).map(e=>({ts:e.ts,method:e.method,params:e.params,peerId:e.peerId}));
 receipt.newNameAbsent=!receipt.after.groups.some(g=>g.name==='QASTALE');
 receipt.finishedAt=new Date().toISOString();receipt.pass=receipt.catalogUnchanged&&receipt.newNameAbsent&&receipt.actualMutationRequests.length===0;
 console.log(JSON.stringify({pass:receipt.pass,oldPeer:receipt.oldOperator.peerId,newPeer:receipt.newOperator.peerId,sameEndpoint:true,catalogUnchanged:receipt.catalogUnchanged,actualMutationCount:receipt.actualMutationRequests.length}));
 if(!receipt.pass)throw Error('Retired request mutated catalog');
}finally{await control('release',true).catch(()=>{});await fs.writeFile(run+'/stale-replacement-native-receipt.json',JSON.stringify(receipt,null,2));await client.stopAndWait();}

