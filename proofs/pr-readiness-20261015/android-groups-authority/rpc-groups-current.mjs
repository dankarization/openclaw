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
 const result=await client.request(method,JSON.parse(paramsText));
 await fs.writeFile(`${run}/${resultName}.private.json`,JSON.stringify({method,grantedScopes:hello.auth?.scopes,result},null,2),{mode:0o600});
 console.log(JSON.stringify({ok:true,method,grantedScopes:hello.auth?.scopes,resultKeys:result&&typeof result==='object'?Object.keys(result):[]}));
} catch(error) {console.log(JSON.stringify({ok:false,method,error:String(error)}));process.exitCode=1;}
finally {await client.stopAndWait();}
