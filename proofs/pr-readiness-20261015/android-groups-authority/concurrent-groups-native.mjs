import fs from 'node:fs/promises';
const root='/QA_ROOT';
const run=`${root}/groups-proof-20261015/live`;
Object.assign(process.env,{OPENCLAW_STATE_DIR:`${run}/state`,OPENCLAW_CONFIG_PATH:`${run}/openclaw.json`});

const {GatewayClient}=await import(`${root}/android-lane/src/gateway/client.ts`);
const token=(await fs.readFile(`${run}/admin.token`,'utf8')).trim();
const [method='health',paramsText='{}',resultName='rpc-result']=process.argv.slice(2);
if(!/^[a-zA-Z0-9_-]+$/.test(resultName)) throw Error('result name');
let client;
const hello=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('connect timeout')),25000);
 client=new GatewayClient({url:'ws://127.0.0.1:18943',token,clientName:'cli',mode:'cli',requestTimeoutMs:120000,clientDisplayName:'Android QA administrator',scopes:['operator.admin','operator.read','operator.write','operator.pairing'],onHelloOk:h=>{clearTimeout(timer);resolve(h)},onConnectError:e=>{clearTimeout(timer);reject(e)}});
 client.start();
});
try {
 const {execFileSync}=await import('node:child_process');
 const coordinates=JSON.parse(await fs.readFile(`${run}/concurrent-v3-create-coordinates.json`,'utf8'));
 const control=async path=>await(await fetch(`http://127.0.0.1:18946/${path}`,{method:'POST',body:'{}'})).json();
 const before=await client.request('sessions.groups.list',{});
 const started=Date.now(); await control('hold-next-groups-list');
 execFileSync(`${root}/android-tools/sdk/platform-tools/adb`,['-s','emulator-5560','shell','input','tap',...coordinates]);
 let held=false;for(let i=0;i<30;i++){const st=await(await fetch('http://127.0.0.1:18946/status')).json();if(st.held){held=true;break}await new Promise(r=>setTimeout(r,50));}
 if(!held)throw Error('Native UI response not held');
 let second;
 try {second=await client.request('sessions.groups.put',{names:['QA_NATIVE_CONCURRENT_2'],appendOnly:true});}
 finally{await control('release');}
 await new Promise(r=>setTimeout(r,500));
 const after=await client.request('sessions.groups.list',{});
 const names=after.groups.map(g=>g.name);
 const receipt={before,second,after,holdDurationUpperMs:Date.now()-started,bothWritersRetained:['QA_UI_CONCURRENT_2','QA_NATIVE_CONCURRENT_2','QA_REMOTE_EXISTING','QA_WRITE_ONLY'].every(n=>names.includes(n))};
 await fs.writeFile(`${run}/concurrent-v3-native-receipt.json`,JSON.stringify(receipt,null,2));
 console.log(JSON.stringify(receipt));if(!receipt.bothWritersRetained)throw Error('Concurrent entry missing');
}finally{await client.stopAndWait();}
