import fs from 'node:fs/promises';
const root='/home/dankar/openclaw-pr-qa-20261014',run=root+'/groups-proof-20261015/live';
Object.assign(process.env,{OPENCLAW_STATE_DIR:run+'/state',OPENCLAW_CONFIG_PATH:run+'/openclaw.json'});
const {GatewayClient}=await import(root+'/android-lane/src/gateway/client.ts');
const token=(await fs.readFile(run+'/admin.token','utf8')).trim();
let client;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('connect timeout')),25000);client=new GatewayClient({url:'ws://127.0.0.1:18943',token,clientName:'cli',mode:'cli',requestTimeoutMs:120000,clientDisplayName:'QA pagination fixture',scopes:['operator.admin','operator.read','operator.write','operator.pairing'],onHelloOk:()=>{clearTimeout(timer);resolve()},onConnectError:e=>{clearTimeout(timer);reject(e)}});client.start()});
const receipt={kind:'native-RPC-synthetic-roster-preparation',startedAt:new Date().toISOString(),count:0,created:[],failures:[]};
try{
 receipt.catalogBefore=await client.request('sessions.groups.list',{});
 await client.request('sessions.groups.put',{names:['QA_PAGE_FIRST','QA_PAGE_TAIL'],appendOnly:true});
 // Sequential creation defines the real native updatedAt ordering; no model turns or direct DB writes.
 for(let i=1;i<=202;i++){
  const id=String(i).padStart(3,'0'),key='agent:main:qa-page-'+id;
  try{await client.request('sessions.create',{key,label:'QA_PAGE_'+id,category:i<=2?'QA_PAGE_TAIL':'QA_PAGE_FIRST',visibility:'shared'});receipt.created.push(key);receipt.count++;}
  catch(e){receipt.failures.push({i,error:String(e)});throw e;}
 }
 receipt.first=await client.request('sessions.list',{limit:200,offset:0,includeGlobal:false,includeUnknown:false});
 receipt.next=await client.request('sessions.list',{limit:200,offset:200,includeGlobal:false,includeUnknown:false});
 receipt.finishedAt=new Date().toISOString();
 await fs.writeFile(run+'/pagination-preparation.private.json',JSON.stringify(receipt,null,2));
 console.log(JSON.stringify({created:receipt.count,firstRows:receipt.first.sessions?.length,nextRows:receipt.next.sessions?.length,firstKeys:Object.keys(receipt.first),nextKeys:Object.keys(receipt.next)}));
}finally{await fs.writeFile(run+'/pagination-preparation.private.json',JSON.stringify(receipt,null,2));await client.stopAndWait();}
