// QA-only native systemd adapter proof. No Gateway/model/update deployment.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
const args=new Map();
for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i].replace(/^--/,""),process.argv[i+1]);
const required=k=>{if(!args.get(k))throw Error("Missing "+k);return args.get(k)};
const task="/PATH/TO/OWN/QA-TASK";
const base=task+"/doctor-process-proof";
const repo=await fs.realpath(required("repo"));
const kind=required("kind"),run=required("run");
if(!repo.startsWith(task+"/")||!["main","candidate"].includes(kind)||!/^[a-z0-9-]+$/.test(run))throw Error("Owned QA input required");
const expectedHead=required("head");
const localHead=execFileSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
if(localHead!==expectedHead)throw Error("Exact local HEAD mismatch");
const tree=execFileSync("git",["-C",repo,"rev-parse","HEAD^{tree}"],{encoding:"utf8"}).trim();
if(kind==="candidate"&&tree!=="9e47e8c86e5b86acc02787fd3a3f485bc1ea411a")throw Error("Published candidate tree mismatch");
const profile=base+"/"+run+"-"+kind;
const unit="openclaw-qa-doctor-20261014-"+run+"-"+kind;
if(unit.length>180)throw Error("QA unit name too long");
const env={...process.env,OPENCLAW_SYSTEMD_UNIT:unit,OPENCLAW_STATE_DIR:profile+"/state"};
process.env.OPENCLAW_STATE_DIR=env.OPENCLAW_STATE_DIR;
process.env.TSX_TSCONFIG_PATH=repo+"/tsconfig.json";
process.env.TSX_DISABLE_CACHE="1";
const requireRepo=createRequire(repo+"/package.json");
const {register}=await import(pathToFileURL(requireRepo.resolve("tsx/esm/api")));
register({tsconfig:repo+"/tsconfig.json"});
const load=(root,file)=>import(pathToFileURL(root+"/"+file));
const {withGatewayServiceOperationLock}=await load(repo,"src/daemon/service-operation-lock.ts");
if(args.get("mode")==="hold"){
 await withGatewayServiceOperationLock(env,async assertCurrent=>{
  await fs.writeFile(required("marker"),JSON.stringify({pid:process.pid,heldAt:Date.now()})+"\n",{mode:0o600,flag:"wx"});
  await new Promise(r=>setTimeout(r,1500));assertCurrent();
 });process.exit(0);
}
await fs.mkdir(profile,{mode:0o700}); // Refuse reset/reuse.
const {resolveRemainingDoctorServiceInspectionTimeoutMs:remaining}=await load(base+"/repo","src/infra/update-doctor-deadline.ts");
const {startSystemdService,stopSystemdService}=await load(repo,"src/daemon/systemd-lifecycle.ts");
const {readSystemdServiceRuntime}=await load(repo,"src/daemon/systemd-runtime.ts");
const {readSystemdServiceExecStart,resolveSystemdUnitPath}=await load(repo,"src/daemon/systemd-service-files.ts");
const unitPath=resolveSystemdUnitPath(env);
if(unitPath!==path.join(os.homedir(),".config/systemd/user",unit+".service"))throw Error("Unexpected unit path");
try{await fs.lstat(unitPath);throw Error("QA unit file already exists");}catch(e){if(e.code!=="ENOENT")throw e}
const port=kind==="candidate"?18962:18961;
await new Promise((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen(port,"127.0.0.1",()=>s.close(resolve));});
const childPath=profile+"/qa-http-child.mjs";
const events=profile+"/child-events.private.jsonl";
await fs.writeFile(childPath,`import fs from "node:fs";
import http from "node:http";
const log=event=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({event,pid:process.pid,at:Date.now()})+"\\n");
const s=http.createServer((req,res)=>{res.writeHead(req.url==="/ready"?200:404);res.end("QA fixture, not Gateway");});
s.listen(${port},"127.0.0.1",()=>log("ready"));
process.once("SIGTERM",()=>{log("SIGTERM");s.close(()=>process.exit(0));});
`,{mode:0o600,flag:"wx"});
const unitText="[Unit]\nDescription=Task-owned Doctor native adapter QA fixture, not Gateway\n[Service]\nType=simple\nExecStart="+process.execPath+" "+childPath+"\nExecStop=/usr/bin/sleep 6\nTimeoutStopSec=12\nRestart=no\nKillMode=control-group\n";
const sha=v=>createHash("sha256").update(v).digest("hex");
await fs.mkdir(path.dirname(unitPath),{recursive:true});
await fs.writeFile(unitPath,unitText,{mode:0o600,flag:"wx"});
const assertOwned=async()=>{if(await fs.readFile(unitPath,"utf8")!==unitText)throw Error("Own QA unit changed; refusing mutation/cleanup")};
const ctl=(...argv)=>execFileSync("systemctl",["--user",...argv],{env,encoding:"utf8",timeout:20000});
const stdout=new PassThrough();stdout.resume();
const receipt={kind,run,localHead,tree,publishedHead:kind==="candidate"?"6bb9c0749da3f2232f72da7837f314ef2d35bf70":localHead,startedAt:new Date().toISOString(),
 scope:"Real clock/process/custody/native systemd adapter proof on a task-owned HTTP fixture service. Not Doctor CLI, managed Gateway readiness or published-driver upgrade acceptance.",
 unitName:unit,unitDefinitionSha256:sha(unitText),serviceFixture:"HTTP /ready child; not OpenClaw Gateway",stopFixture:"Actual systemd ExecStop child /usr/bin/sleep 6",cases:[],usesFakeClock:false,usesMockDiscovery:false,usesMockCommand:false};
let installed=true,holder;
const inspection=async()=>{
 const command=await readSystemdServiceExecStart(env,{requireEffective:true});
 const runtime=await readSystemdServiceRuntime(env);
 if(!command?.programArguments?.includes(childPath))throw Error("Native service command does not identify own fixture");
 return {status:runtime.status,pid:runtime.pid??null,commandChildMatched:true};
};
const ready=async()=>{
 for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+port+"/ready");if(r.status===200)return {httpStatus:r.status};}catch{}
  await new Promise(r=>setTimeout(r,50));}
 throw Error("Own HTTP fixture not ready");
};
const restore=async assertCurrent=>{await assertOwned();await startSystemdService({env,stdout,assertCurrent});return {...await inspection(),...await ready()}};
try{
 ctl("daemon-reload");
 await restore();
 const before=await inspection();
 if(before.status!=="running"||!before.pid)throw Error("Native initial service inspection failed");
 const marker=profile+"/custody-held.private.json";
 holder=spawn(process.execPath,[new URL(import.meta.url).pathname,"--repo",repo,"--head",expectedHead,"--kind",kind,"--run",run,"--mode","hold","--marker",marker],{env,stdio:["ignore","ignore","pipe"]});
 let childError="";holder.stderr.on("data",b=>childError+=b);
 for(let i=0;;i++){try{await fs.access(marker);break}catch{}if(holder.exitCode!==null||i>600)throw Error("Native custody holder not ready: "+childError);await new Promise(r=>setTimeout(r,50))}
 const deadline=Date.now()+500,attempt=Date.now(),guards=[],mutations=[];
 let expiredError;
 try{
  await withGatewayServiceOperationLock(env,async assertCurrent=>{
   await assertOwned();
   await stopSystemdService({env,stdout,assertCurrent,beforeEffect:()=>{guards.push(Date.now());remaining(deadline)},onMutation:()=>mutations.push(Date.now())});
  });
 }catch(e){expiredError=String(e)}
 if(holder.exitCode===null)await once(holder,"close");
 if(holder.exitCode!==0)throw Error("Native custody process failed: "+childError);
 const after=await inspection();
 if(kind==="candidate"){
  if(!expiredError?.includes("Doctor service-inspection deadline has expired")||guards.length!==1||guards[0]<deadline||mutations.length||after.status!=="running"||after.pid!==before.pid)throw Error("Candidate did not prevent post-expiry native dispatch");
  await ready();
 }else{
  if(expiredError||guards.length||mutations.length!==1||after.status==="running")throw Error("Baseline did not demonstrate ignored deadline dispatch");
  await withGatewayServiceOperationLock(env,assertCurrent=>restore(assertCurrent));
 }
 receipt.cases.push({name:"expiry-after-real-custody",deadlineAtMs:deadline,attemptAtMs:attempt,finishedAtMs:Date.now(),custodyHolderPid:holder.pid,guardCalls:guards.length,guardAtMs:guards[0]??null,mutationCount:mutations.length,observed:kind==="candidate"?"expired before stop, original service PID remains":"baseline incorrectly stopped service after expiry",samePid:before.pid===after.pid,expectedError:expiredError??null,passed:true});
 if(kind==="candidate"){
  for(const name of ["admitted-effect-settlement","omitted-deadline"]){
   await withGatewayServiceOperationLock(env,async assertCurrent=>{
    await assertOwned();const old=await inspection();
    const deadlineAtMs=name==="admitted-effect-settlement"?Date.now()+3000:undefined;
    const guards=[],mutations=[],startedAtMs=Date.now();
    await stopSystemdService({env,stdout,assertCurrent,beforeEffect:()=>{guards.push(Date.now());remaining(deadlineAtMs)},onMutation:()=>mutations.push(Date.now())});
    const settledAtMs=Date.now(),stopped=await inspection();
    if(guards.length!==1||mutations.length!==1||stopped.status==="running"||(deadlineAtMs!==undefined&&(guards[0]>=deadlineAtMs||settledAtMs<=deadlineAtMs)))throw Error("Actual native stop did not settle under intended deadline state");
    // Restoration has current custody authority; it intentionally receives no expired work guard.
    const restored=await restore(assertCurrent);
    assertCurrent();
    if(restored.status!=="running"||!restored.pid||restored.pid===old.pid||restored.httpStatus!==200)throw Error("Own fixture restoration failed");
    receipt.cases.push({name,deadlineAtMs:deadlineAtMs??null,startedAtMs,guardAtMs:guards[0],settledAtMs,mutationAtMs:mutations[0],mutationCount:mutations.length,stopElapsedMs:settledAtMs-startedAtMs,serviceStopped:stopped.status!=="running",restoredRunning:restored.status==="running",restoredNewPid:restored.pid!==old.pid,fixtureReadyHttpStatus:restored.httpStatus,gatewayReadinessClaimed:false,passed:true});
   });
  }
 }
 receipt.passed=true;
}catch(e){receipt.passed=false;receipt.error=String(e);}
finally{
 try{
  if(holder?.exitCode===null){holder.kill("SIGTERM");await once(holder,"close")}
  await assertOwned();
  const fragment=ctl("show",unit+".service","--property=FragmentPath","--value").trim();
  if(fragment!==unitPath)throw Error("Own unit fragment changed; refuse cleanup");
  ctl("stop",unit+".service");
  await fs.unlink(unitPath);installed=false;
  ctl("daemon-reload");
  receipt.cleanup={ownUnitRemoved:true,ownServiceStopped:true,otherUnitsModified:false};
 }catch(e){receipt.cleanup={error:String(e),unitFileStillOwned:installed};receipt.passed=false;}
 receipt.finishedAt=new Date().toISOString();
 const rawEvents=await fs.readFile(events,"utf8").catch(()=>"");
 receipt.realChildEvents=rawEvents.trim()?rawEvents.trim().split("\n").map(s=>JSON.parse(s)):[];
 await fs.writeFile(profile+"/receipt.sanitized.json",JSON.stringify(receipt,null,2)+"\n",{mode:0o600,flag:"wx"});
 console.log(JSON.stringify(receipt,null,2));
}
process.exit(receipt.passed?0:1);
