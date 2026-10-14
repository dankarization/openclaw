// QA wire fault fixture: omit only Medium from advertised picker choices.
// Effective thinkingLevel/default, auth, mutation handlers and chat.send are untouched.
import http from 'node:http';
import fs from 'node:fs';
import {createRequire} from 'node:module';
if(process.env.OC_ANDROID_INCOMPLETE_PROOF!=='1')throw Error('Explicit QA fixture activation required');
const root='/QA_ROOT';
const require=createRequire(`${root}/repo/package.json`);
const {WebSocket,WebSocketServer}=require('ws');
const records=`${root}/android-proof/live/metadata-relay-events.private.ndjson`;
const note=(event,data={})=>fs.appendFileSync(records,JSON.stringify({ts:new Date().toISOString(),event,...data})+'\n',{mode:0o600});
let offline=false;const peers=new Set();
function omitMedium(obj,context){
 if(!obj||typeof obj!=='object')return;
 const before={thinkingLevel:obj.thinkingLevel,thinkingDefault:obj.thinkingDefault};let changes=0;
 for(const key of ['thinkingLevels','thinkingOptions'])if(Array.isArray(obj[key])){
  const original=obj[key];obj[key]=original.filter(v=>(typeof v==='string'?v.toLowerCase():String(v?.id).toLowerCase())!=='medium');
  if(original.length!==obj[key].length){changes++;note('metadata-medium-omitted',{context,key,before:original,after:obj[key],effectiveThinking:before});}
 }
 if(before.thinkingLevel!==obj.thinkingLevel||before.thinkingDefault!==obj.thinkingDefault)throw Error('Effective state must remain native');
 return changes;
}
const wss=new WebSocketServer({host:'127.0.0.1',port:18945});
wss.on('connection',down=>{
 if(offline){note('reconnect-paused');down.close(1013,'QA reconnect pause');return;}
 const up=new WebSocket('ws://127.0.0.1:18943');const peer={down,up,role:null,scopes:[],methods:new Map()};peers.add(peer);const queue=[];
 down.on('message',(data,binary)=>{
  if(!binary)try{const f=JSON.parse(data);if(f.type==='req'){
   peer.methods.set(f.id,f.method);
   if(f.method==='connect'){peer.role=f.params.role;note('connect-request',{role:peer.role,requestedScopes:f.params.scopes});}
   else if(['sessions.patch','chat.send'].includes(f.method))note('android-request',{id:f.id,method:f.method,thinking:f.params.thinking,thinkingLevel:f.params.thinkingLevel,message:f.params.message});
  }}catch{}
  if(up.readyState===WebSocket.OPEN)up.send(data,{binary});else queue.push([data,binary]);
 });
 up.on('open',()=>{for(const[data,binary]of queue)up.send(data,{binary});});
 up.on('message',(data,binary)=>{
  let forwarded=data;
  if(!binary)try{const f=JSON.parse(data),method=peer.methods.get(f.id);
   if(f.type==='res'&&method==='connect'&&f.ok){peer.scopes=f.payload.auth?.scopes||[];note('authenticated',{role:peer.role,grantedScopes:peer.scopes});}
   if(f.type==='res'&&f.ok){
    let changed=0;
    if(method==='models.list')for(const row of f.payload?.models||[])changed+=omitMedium(row,'models.list')||0;
    if(method==='sessions.list'){
     changed+=omitMedium(f.payload?.defaults,'sessions.list.defaults')||0;
     for(const row of f.payload?.sessions||[])if(row.key==='agent:main:main')changed+=omitMedium(row,'sessions.list.main')||0;
    }
    if(method==='chat.history')changed+=omitMedium(f.payload?.sessionInfo,'chat.history.sessionInfo')||0;
    if(changed)forwarded=JSON.stringify(f);
   }
   if(f.type==='res'&&['sessions.patch','chat.send'].includes(method))note('native-result',{id:f.id,method,ok:f.ok,error:f.error,payload:f.payload});
  }catch(error){note('fixture-frame-error',{error:String(error)});down.close(1011,'QA fixture failure');return;}
  if(down.readyState===WebSocket.OPEN)down.send(forwarded,{binary});
 });
 up.on('close',(code,reason)=>{note('upstream-close',{role:peer.role,code,reason:String(reason)});if(down.readyState===WebSocket.OPEN)down.close([1005,1006,1015].includes(code)?1011:code,reason);peers.delete(peer);});
 down.on('close',()=>{if(up.readyState===WebSocket.OPEN)up.close();peers.delete(peer);});
 up.on('error',error=>note('upstream-error',{error:String(error)}));
});
http.createServer(async(req,res)=>{
 try{
  for await(const _ of req){}
  if(req.url==='/offline'){
   offline=true;note('offline-control');for(const p of peers){if(p.up.readyState===WebSocket.OPEN)p.up.close(1012,'QA reconnect pause');if(p.down.readyState===WebSocket.OPEN)p.down.close(1012,'QA reconnect pause');}
  }else if(req.url==='/online'){offline=false;note('online-control');}
  else if(req.url!=='/status')throw Error('unknown control');
  res.setHeader('content-type','application/json');res.end(JSON.stringify({offline,peers:[...peers].map(p=>({role:p.role,scopes:p.scopes,connected:p.up.readyState===WebSocket.OPEN}))}));
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
}).listen(18946,'127.0.0.1');note('metadata-relay-ready');
