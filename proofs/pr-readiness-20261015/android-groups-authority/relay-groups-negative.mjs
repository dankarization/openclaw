import http from 'node:http';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const root='/QA_ROOT';
const require=createRequire(`${root}/android-lane/package.json`);
const {WebSocket,WebSocketServer}=require('ws');
const records=`${root}/groups-proof-20261015/live/relay-negative-events.ndjson`;
const note=(event,data={})=>fs.appendFileSync(records,JSON.stringify({ts:new Date().toISOString(),event,...data})+'\n',{mode:0o600});
const peers=new Set(),pending=new Map();let next=0,hold=false,held,holdMethod=null,peerSequence=0;
const wss=new WebSocketServer({host:'127.0.0.1',port:18945});
wss.on('connection',down=>{
 const up=new WebSocket('ws://127.0.0.1:18943');
 const peer={peerId:++peerSequence,down,up,role:null,scopes:[],methods:new Map(),open:false};peers.add(peer);
 const queue=[];
 down.on('message',(data,binary)=>{
  if(!binary)try{const f=JSON.parse(data);if(f.type==='req'){
   peer.methods.set(f.id,f.method);
   if(f.method==='connect'){peer.role=f.params.role;note('connect-request',{role:peer.role,requestedScopes:f.params.scopes});}
   else if(f.method==='sessions.patch'||f.method==='chat.send'||f.method.startsWith('sessions.groups.')||f.method==='sessions.list')note('android-request',{peerId:peer.peerId,id:f.id,method:f.method,thinkingLevel:f.params.thinkingLevel,params:f.params});
  }}catch{}
  if(up.readyState===WebSocket.OPEN)up.send(data,{binary});else queue.push([data,binary]);
 });
 up.on('open',()=>{peer.open=true;for(const[data,binary]of queue)up.send(data,{binary});});
 up.on('message',(data,binary)=>{
  if(!binary)try{const f=JSON.parse(data),method=peer.methods.get(f.id);
   if(pending.has(f.id)){pending.get(f.id)(f);pending.delete(f.id);note('injected-response',{id:f.id,ok:f.ok,error:f.error?.message});return;}
   if(f.type==='res'&&method==='connect'&&f.ok){peer.scopes=f.payload.auth?.scopes||[];note('authenticated',{peerId:peer.peerId,role:peer.role,grantedScopes:peer.scopes});}
   if(f.type==='res'&&(method?.startsWith('sessions.groups.')||method==='sessions.list'))note('android-native-result',{peerId:peer.peerId,id:f.id,method,ok:f.ok,payload:f.payload,error:f.error});
   if(f.type==='res'&&method===holdMethod&&!held){holdMethod=null;held={peer,data,binary};note('native-response-held',{peerId:peer.peerId,id:f.id,method,ok:f.ok});return;}
   if(f.type==='res'&&method==='sessions.patch'){
    note('android-patch-result',{id:f.id,ok:f.ok,error:f.error?.message});
    if(hold&&!held){hold=false;held={peer,data,binary};note('patch-ack-held',{id:f.id});return;}
   }
  }catch{}
  if(down.readyState===WebSocket.OPEN)down.send(data,{binary});
 });
 up.on('close',(code,reason)=>{note('upstream-close',{peerId:peer.peerId,role:peer.role,code,reason:String(reason)});if(down.readyState===WebSocket.OPEN)down.close(code===1006?1011:code,reason);peers.delete(peer);});
 down.on('close',()=>{if(up.readyState===WebSocket.OPEN)up.close();peers.delete(peer);});
 up.on('error',e=>note('upstream-error',{error:String(e)}));
});
http.createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  let result;
  if(req.url==='/status')result={peers:[...peers].map(p=>({peerId:p.peerId,role:p.role,scopes:p.scopes,connected:p.up.readyState===WebSocket.OPEN})),held:Boolean(held)};
  else if(req.url==='/hold-next-groups-list'){if(held||holdMethod)throw Error('Existing held or armed native response');holdMethod='sessions.groups.list';result={armed:true,method:holdMethod};note('native-response-hold-armed',{method:holdMethod});}
  else if(req.url==='/hold-next-patch'){hold=true;result={armed:true};}
  else if(req.url==='/release'){if(held&&held.peer.down.readyState===WebSocket.OPEN)held.peer.down.send(held.data,{binary:held.binary});held=null;result={released:true};note('release');}
  else if(req.url==='/rpc'){
   if(!['health','sessions.list','sessions.patch','sessions.groups.list','sessions.groups.put'].includes(input.method))throw Error('not allowed');
   const peer=[...peers].find(p=>p.role==='operator'&&p.up.readyState===WebSocket.OPEN&&p.scopes.length);if(!peer)throw Error('no authenticated operator');
   const id=`qa-negative-control-${++next}`;note('injected-request',{id,method:input.method,grantedScopes:peer.scopes,thinkingLevel:input.params?.thinkingLevel});
   result=await new Promise((resolve,reject)=>{pending.set(id,resolve);peer.up.send(JSON.stringify({type:'req',id,method:input.method,params:input.params||{}}));setTimeout(()=>{if(pending.delete(id))reject(Error('timeout'));},20000).unref();});
  }else throw Error('unknown control');
  res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}
}).listen(18946,'127.0.0.1');
note('relay-ready',{wsPort:18945,controlPort:18946});
