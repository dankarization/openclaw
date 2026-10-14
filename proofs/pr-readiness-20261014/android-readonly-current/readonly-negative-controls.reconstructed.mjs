// Reconstructed reproduction helper, not the original inline capture program.
// Operands come from the published result.json; this file was NOT run for its 75 ms receipt.
// Requires the separately published, already running QA relay on an isolated Android environment.
import fs from "node:fs/promises";
const args=new Map(process.argv.slice(2).map(s=>{const i=s.indexOf("=");return i<0?[s,true]:[s.slice(0,i),s.slice(i+1)]}));
const recorded=JSON.parse(await fs.readFile(new URL("./result.json",import.meta.url),"utf8"));
const sessionKey=args.get("--session-key");
if(!sessionKey)throw Error("Supply the disposable QA session key using --session-key=...");
const specs=recorded.mutations.map(x=>x.patch);
if(JSON.stringify(specs)!==JSON.stringify([{thinkingLevel:"high"},{fastMode:true}]))throw Error("Recorded operands changed");
const requests=specs.map(patch=>({method:"sessions.patch",params:{key:sessionKey,...patch}}));
if(!args.has("--execute")){console.log(JSON.stringify({status:"DRY_RUN_RECONSTRUCTION",requests},null,2));process.exit(0)}
const root=args.get("--relay");
if(!root||new URL(root).hostname!=="127.0.0.1"||new URL(root).protocol!=="http:")throw Error("Explicit own loopback QA relay required");
const post=async(route,payload={})=>{const r=await fetch(new URL(route,root),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error("QA relay HTTP "+r.status);return r.json()};
const peers=(await post("/status")).peers.filter(p=>p.connected&&p.role==="operator");
if(peers.length!==1||JSON.stringify(peers[0].scopes)!==JSON.stringify(["operator.read"]))throw Error("Require exactly one actual authenticated Android read-only operator socket");
const rpc=(method,params={})=>post("/rpc",{method,params});
const read=async()=>{const response=await rpc("sessions.list");if(!response.ok)throw Error("Native sessions.list refused");const row=response.payload.sessions.find(r=>r.key===sessionKey);if(!row)throw Error("Own QA session absent");return {thinkingLevel:row.thinkingLevel,fastMode:row.fastMode}};
const before=await read(),mutations=[],start=performance.now();
for(const request of requests){
 const response=await rpc(request.method,request.params);
 mutations.push({patch:recorded.mutations[mutations.length].patch,ok:response.ok,error:response.error});
 if(response.ok||response.error?.code!=="FORBIDDEN"||response.error?.details?.missingScope!=="operator.write")throw Error("Expected real native scope denial not observed");
}
const after=await read();
if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Native persisted state changed");
console.log(JSON.stringify({status:"NEW_REPRODUCTION_NOT_ORIGINAL_CAPTURE",grantedScopes:peers[0].scopes,before,mutations,after,preserved:true,elapsedMs:Math.round(performance.now()-start)},null,2));
