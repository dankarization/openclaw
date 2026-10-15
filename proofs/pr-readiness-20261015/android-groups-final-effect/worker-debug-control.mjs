import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const root='/home/dankar/openclaw-pr-qa-20261014', dir=root+'/groups-proof-20261015/live';
const require=createRequire(root+'/android-lane/package.json'), {WebSocket}=require('ws');
const events=[], sessions=new Map(),pending=new Map();let seq=0,armed=false,closed=false;
const note=(event,data={})=>{const row={ts:new Date().toISOString(),event,...data};events.push(row);fs.appendFileSync(dir+'/worker-debug-events.private.ndjson',JSON.stringify(row)+'\n',{mode:0o600});};
const targets=await(await fetch('http://127.0.0.1:18947/json/list')).json();
const ws=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
function main(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete('main:'+id);reject(Error('main command timeout '+method))},15000);pending.set('main:'+id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
function worker(sessionId,method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(sessionId+':'+id);reject(Error('worker command timeout '+method))},15000);pending.set(sessionId+':'+id,{resolve,reject,timer});main('NodeWorker.sendMessageToWorker',{sessionId,message:JSON.stringify({id,method,params})}).catch(e=>{clearTimeout(timer);pending.delete(sessionId+':'+id);reject(e)});});}
function receive(key,m){const p=pending.get(key+':'+m.id);if(!p)return;clearTimeout(p.timer);pending.delete(key+':'+m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
async function locateFn(s,scriptId,url){
 if(s.locating||s.location)return;s.locating=true;
 try{
  const r=await worker(s.id,'Debugger.getScriptSource',{scriptId});
  const src=r.scriptSource;
  const start=src.indexOf('function requestSqliteWorkerOperationAdmission');
  fs.writeFileSync(dir+'/worker-admission-script.private.txt',src,{mode:0o600});
  if(start<0)throw Error('Named native admission function missing in loaded script');
  const effect=src.indexOf('currentAdmission.getStore()',start);
  const fallback=src.indexOf('.getStore()',start);
  const at=effect>=0?effect:fallback;
  if(at<0)throw Error('Native admission scope expression missing');
  const prior=src.slice(0,at);
  const lineNumber=prior.split('\n').length-1,columnNumber=prior.length-(prior.lastIndexOf('\n')+1);
  const possible=await worker(s.id,'Debugger.getPossibleBreakpoints',{start:{scriptId,lineNumber,columnNumber:Math.max(0,columnNumber-35)},end:{scriptId,lineNumber,columnNumber:columnNumber+180}});
  if(!possible.locations.length)throw Error('No executable native admission location');
  s.location=possible.locations[0];s.nativeSnippet=src.slice(start,start+650);
  note('native-admission-location',{sessionId:s.id,title:s.title,location:s.location,snippet:s.nativeSnippet});
  if(armed)await armOne(s);
 }catch(e){s.error=String(e);note('locate-error',{sessionId:s.id,error:String(e).slice(0,500)})}
}
async function armOne(s){
 if(!s.location||s.breakpoint)return;
 const r=await worker(s.id,'Debugger.setBreakpoint',{location:s.location,condition:"request.stage === 'commit' && new Error().stack.includes('session-group-catalog')"});
 s.breakpoint=r.breakpointId;note('native-commit-breakpoint-armed',{sessionId:s.id,actualLocation:r.actualLocation});
}
ws.on('message',async data=>{
 const m=JSON.parse(data);
 if(m.id)return receive('main',m);
 try{
 if(m.method==='NodeWorker.attachedToWorker'){
  const p=m.params,s={id:p.sessionId,title:p.workerInfo.title,url:p.workerInfo.url,scripts:new Map(),paused:false};sessions.set(s.id,s);note('worker-attached',{sessionId:s.id,title:s.title});
  await worker(s.id,'Runtime.enable');await worker(s.id,'Debugger.enable');
 }else if(m.method==='NodeWorker.receivedMessageFromWorker'){
  const id=m.params.sessionId,w=JSON.parse(m.params.message),s=sessions.get(id);if(!s)return;
  if(w.id)return receive(id,w);
  if(w.method==='Debugger.scriptParsed'){
   s.scripts.set(w.params.scriptId,w.params.url);
   if(w.params.url.endsWith('/sqlite-writer-admission-client.ts'))void locateFn(s,w.params.scriptId,w.params.url);
  }else if(w.method==='Debugger.paused'){
   s.paused=true;s.frames=w.params.callFrames;
   const f=w.params.callFrames[0];
   const stage=await worker(id,'Debugger.evaluateOnCallFrame',{callFrameId:f.callFrameId,expression:'arguments[0]?.stage',returnByValue:true});
   s.stage=stage.result?.value;
   note('native-worker-paused',{sessionId:id,stage:s.stage,reason:w.params.reason,frames:w.params.callFrames.slice(0,7).map(f=>({functionName:f.functionName,file:(s.scripts.get(f.location.scriptId)||f.url||'').split('/').at(-1),line:f.location.lineNumber,column:f.location.columnNumber}))});
  }else if(w.method==='Debugger.resumed'){s.paused=false;note('native-worker-resumed',{sessionId:id});}
 }else if(m.method==='NodeWorker.detachedFromWorker'){sessions.delete(m.params.sessionId);}
 }catch(e){note('debug-event-error',{error:String(e).slice(0,600)})}
});
await main('NodeWorker.enable',{waitForDebuggerOnStart:false});
const server=http.createServer(async(req,res)=>{
 try{
 let result;
 if(req.url==='/status')result={armed,sessions:[...sessions.values()].map(s=>({id:s.id,title:s.title,hasNativeAdmission:!!s.location,breakpoint:!!s.breakpoint,paused:s.paused,stage:s.stage,error:s.error})),events:events.slice(-8)};
 else if(req.url==='/arm'&&req.method==='POST'){armed=true;for(const s of sessions.values())await armOne(s);result={armed,located:[...sessions.values()].filter(s=>s.location).length};}
 else if(req.url==='/resume'&&req.method==='POST'){armed=false;for(const s of sessions.values()){if(s.breakpoint){await worker(s.id,'Debugger.removeBreakpoint',{breakpointId:s.breakpoint});s.breakpoint=null;}if(s.paused)await worker(s.id,'Debugger.resume');}result={resumed:true};}
 else throw Error('unknown control');
 res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}
}).listen(18948,'127.0.0.1',()=>note('debug-control-ready'));
async function stop(){if(closed)return;closed=true;armed=false;for(const s of sessions.values())if(s.paused)await worker(s.id,'Debugger.resume').catch(()=>{});ws.close();server.close();setTimeout(()=>process.exit(0),500).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
