// QA-only native owner proof; no poller, mocked getFile, product patch, or web service.
import fs from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const arg = new Map();
for (let i=2;i<process.argv.length;i+=2) arg.set(process.argv[i].replace(/^--/,""),process.argv[i+1]);
const need=k=>{const v=arg.get(k);if(!v)throw Error("Missing --"+k);return v;};
const task="/PATH/TO/OWN/QA-TASK";
const proof=task+"/media-lane/proof";
const repo=await fs.realpath(need("repo"));
const head=need("head"),kind=need("kind"),run=need("run");
if(!repo.startsWith(task+"/")||!["main","candidate"].includes(kind)||!/^[a-zA-Z0-9_-]+$/.test(run))throw Error("Use owned QA checkout/profile");
if(execFileSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).trim()!==head)throw Error("Exact HEAD mismatch");
const expectedBytes=54525952;
const expectedSha="2fade4fa841545c954a8b55e00989b7aa559ece325011a080dae3d4e95fef124";
const profile=proof+"/profiles/"+run+"-"+kind;
await fs.mkdir(path.dirname(profile),{recursive:true,mode:0o700});
await fs.mkdir(profile,{mode:0o700}); // Never reuse/reset an earlier state or failed run.
const state=profile+"/state",configPath=profile+"/config.json";
const apiRoot=process.env.OC_MEDIA_QA_API_ROOT;
if(!apiRoot||new URL(apiRoot).hostname!=="127.0.0.1")throw Error("Supply the approved loopback forwarded Bot API root");
const actualGetFileReceipt=JSON.parse(await fs.readFile(proof+"/getfile.private.json","utf8"));
const trustedRoot=path.dirname(actualGetFileReceipt.result.file_path);
if(await fs.realpath(trustedRoot)!==await fs.realpath(proof+"/bot-api-mirror/documents"))throw Error("Exact QA Bot API alias must resolve only to the owned document mirror");
const tokenFile=task+"/secrets/OWN_QA_TOKEN";
const updateBytes=await fs.readFile(proof+"/captured-document-update.private.json");
const update=JSON.parse(updateBytes),message=update.message,doc=message?.document;
if(doc?.file_name!=="qa-large-document.bin"||doc.file_size!==expectedBytes||!doc.file_id)throw Error("Captured source is not the authorized QA document");
const config={
 agents:{defaults:{workspace:profile+"/workspace",sandbox:{mode:"off"}}},
 session:{dmScope:"per-channel-peer"},
 plugins:{allow:["telegram"],entries:{telegram:{enabled:true}}},
 channels:{telegram:{enabled:true,tokenFile,apiRoot,trustedLocalFileRoots:[trustedRoot],
  dmPolicy:"open",allowFrom:["*"],mediaMaxMb:128,accounts:{default:{mediaMaxMb:64}}}},
 tools:{exec:{host:"gateway",mode:"full"}},
 logging:{level:"error",consoleLevel:"error"}
};
await fs.writeFile(configPath,JSON.stringify(config,null,2)+"\n",{mode:0o600,flag:"wx"});
process.env.OPENCLAW_STATE_DIR=state;
process.env.OPENCLAW_CONFIG_PATH=configPath;
process.env.TSX_TSCONFIG_PATH=repo+"/tsconfig.json";
process.env.TSX_DISABLE_CACHE="1";
const requireRepo=createRequire(repo+"/package.json");
const {register}=await import(pathToFileURL(requireRepo.resolve("tsx/esm/api")));
register({tsconfig:repo+"/tsconfig.json"});
const load=file=>import(pathToFileURL(repo+"/"+file));
const sha=v=>createHash("sha256").update(String(v)).digest("hex");
const fileSha=async p=>{const h=createHash("sha256");for await(const c of createReadStream(p))h.update(c);return h.digest("hex");};
let token;
const receipt={sourceHead:head,kind,run,recordedAt:new Date().toISOString(),proofScope:"real captured Telegram document -> native createTelegramBot/handleUpdate intake/getFile -> native channel/account context -> native host staging -> native exec tool; no complete Gateway poller or model turn",
 transport:"Existing local Telegram Bot API through SSH loopback forward; only the own QA bot file mirrored into an explicitly trusted QA root",
 sourceIdentitySha256:sha(JSON.stringify([update.update_id,message.chat.id,message.message_id])),
 updateSha256:createHash("sha256").update(updateBytes).digest("hex"),expectedBytes,expectedSha,
 cases:[],realGetFileCalls:0,usesPolling:false,usesMockGetFile:false,usesModel:false};
try{
 const {runWithLocalStateOwner}=await load("src/cli/local-state-owner.ts");
 await runWithLocalStateOwner({method:"qa.telegram-large-managed-media",params:{},target:state,onForeignOwner:"refuse",
 runLocal:async({config:cfg,assertCurrent,signal})=>{
  const {setRuntimeConfigSnapshot}=await load("src/config/runtime-snapshot.ts");
  setRuntimeConfigSnapshot(cfg,cfg);
  const {readTelegramTokenFile}=await load("extensions/telegram/src/token.ts");
  token=readTelegramTokenFile(tokenFile,"channels.telegram.tokenFile").token;
  if(!token)throw Error("Own QA token unavailable");
  const {loadAndActivateRootPluginRegistry}=await load("src/plugins/loader.ts");
  const registry=await loadAndActivateRootPluginRegistry({config:cfg,onlyPluginIds:["telegram"],pluginSdkResolution:"src",preferBuiltPluginArtifacts:false,cache:false});
  const {getPluginInstance}=await load("src/plugins/plugin-instance-scope.ts");
  const instance=getPluginInstance(registry.plugins.find(p=>p.id==="telegram"));
  if(!instance?.acceptingCalls)throw Error("Actual Telegram plugin instance unavailable");
  await instance.runInRegistry(registry,async()=>{
  const {createTelegramBot}=await load("extensions/telegram/src/bot.ts");
  const {defaultTelegramBotDeps}=await load("extensions/telegram/src/bot-deps.ts");
  const cutoff=new Error("QA_NATIVE_CONTEXT_CAPTURED_BEFORE_MODEL_TURN");
  let nativeInbound;
  const bot=await createTelegramBot({token,accountId:"default",config:cfg,buildContext:async(...input)=>{
   const value=await defaultTelegramBotDeps.buildChannelInboundEventContext(...input);
   if(String(value?.MessageSid)!==String(message.message_id))throw Error("Native context source identity mismatch");
   nativeInbound=value;throw cutoff;
  }});
  bot.api.config.use(async(prev,method,payload,abort)=>{
   const actual=await prev(method,payload,abort);
   if(method==="getFile"&&payload.file_id===doc.file_id){
    receipt.realGetFileCalls++;
    if(!actual.ok||!actual.result?.file_path)throw Error("Actual Bot API getFile returned no file_path");
    receipt.actualGetFilePathSha256=sha(actual.result.file_path);
   }
   return actual;
  });
  try{
   await bot.init();
   try{await bot.handleUpdate(update);}catch(error){if(error!==cutoff)throw error;}
  }finally{try{await bot.stop();}catch(error){if(bot.isRunning())throw error;}}
  if(!nativeInbound||nativeInbound.Provider!=="telegram"||nativeInbound.AccountId!=="default"||!nativeInbound.SessionKey)throw Error("Actual Telegram handler did not supply channel/account/session identity");
  const {buildInboundMediaUriFromPath,resolveInboundMediaReference}=await load("src/media/media-reference.ts");
  const nativeFact=nativeInbound.media?.[0];
  const nativeRef=nativeFact&&await resolveInboundMediaReference(nativeFact.path??nativeFact.url);
  if(!nativeRef)throw Error("Actual handler did not create a managed inbound reference");
  const saved={path:nativeRef.physicalPath,contentType:nativeFact.contentType,size:(await fs.stat(nativeRef.physicalPath)).size};
  if(saved.size!==expectedBytes||await fileSha(saved.path)!==expectedSha||receipt.realGetFileCalls!==1)throw Error("Actual native Telegram intake did not match original bytes/hash/getFile call");
  const managedUri=buildInboundMediaUriFromPath(saved.path);
  receipt.nativeMediaPath=saved.path;receipt.managedUri=managedUri;
  receipt.actualIntake={bytes:saved.size,sha256:expectedSha,nativeKind:nativeFact.nativeKind??null};
  receipt.identity={channel:nativeInbound.Provider,accountId:nativeInbound.AccountId,sourceMessageSidSha256:sha(nativeInbound.MessageSid),sessionKeySha256:sha(nativeInbound.SessionKey),source:"Actual createTelegramBot/handleUpdate -> native buildChannelInboundEventContext; not manually assigned"};
  const {stageSandboxMedia}=await load("src/auto-reply/reply/stage-sandbox-media.ts");
  const {createExecTool}=await load("src/agents/bash-tools.exec-run.ts");
  const key=nativeInbound.SessionKey;
  const runStage=async(name,channelMb,accountMb,sourceUri,expectedAccepted,expectedRejectedLimit)=>{
   const work=profile+"/workspace-"+name;
   const stageCfg=structuredClone(cfg);
   stageCfg.agents.defaults.workspace=work;
   stageCfg.channels.telegram.mediaMaxMb=channelMb;
   stageCfg.channels.telegram.accounts.default.mediaMaxMb=accountMb;
   setRuntimeConfigSnapshot(stageCfg,stageCfg);
   const inbound=structuredClone(nativeInbound);
   inbound.media=[{...nativeFact,path:sourceUri,url:sourceUri}];
   const sessionCtx=structuredClone(inbound),warnings=[],warn=console.warn;
   console.warn=(...values)=>warnings.push(values.map(String).join(" "));
   let staged;
   try{staged=await stageSandboxMedia({ctx:inbound,sessionCtx,cfg:stageCfg,agentId:"main",sessionKey:key,workspaceDir:work,abortSignal:signal});}
   finally{console.warn=warn;}
   const target=staged.staged.get(0);
   const result={name,channelMiB:channelMb,accountMiB:accountMb,stagedCount:staged.staged.size,expectedAccepted};
   if(!expectedAccepted){
    if(target||staged.staged.size!==0||!warnings.some(w=>w.includes("file exceeds limit of "+expectedRejectedLimit+" bytes")))throw Error("Expected causal size-limit rejection missing for "+name);
    result.rejectedLimitBytes=expectedRejectedLimit;result.passed=true;receipt.cases.push(result);return;
   }
   if(!target||!path.isAbsolute(target)||!target.startsWith(work+"/"))throw Error("Native host staging returned no owned workspace path for "+name);
   const stat=await fs.stat(target);
   if(stat.size!==expectedBytes)throw Error("Native staged byte count mismatch");
   const command="sha256sum -- '"+target.replaceAll("'","'\\''")+"'";
   const tool=createExecTool({host:"gateway",mode:"full",config:stageCfg,agentId:"main",sessionKey:key,cwd:work,
    preparedStoreEnvironment:{},allowBackground:false,timeoutSec:90});
   const toolResult=await tool.execute("qa-checksum-"+name,{command,workdir:work,timeoutSeconds:90,yieldMs:1000},signal);
   const text=(toolResult.content??[]).filter(c=>c.type==="text").map(c=>c.text).join("\n");
   if(toolResult.isError||!text.includes(expectedSha)||toolResult.details?.status==="running")throw Error("Native exec tool did not complete the staged-path checksum");
   result.stagedBytes=stat.size;result.nativeExecChecksum=expectedSha;result.nativeExecStatus=toolResult.details?.status??"completed";
   result.nativeTool="createExecTool";result.passed=true;receipt.cases.push(result);
  };
  if(kind==="main"){
   await runStage("main-red",128,64,managedUri,false,50*1024*1024);
  }else{
   await runStage("candidate-green",128,64,managedUri,true);
   await runStage("account-lower",128,51,managedUri,false,51*1024*1024);
   await runStage("account-higher",51,64,managedUri,true);
   const baselinePath=need("baseline-receipt");
   if(!path.resolve(baselinePath).startsWith(proof+"/"))throw Error("Baseline receipt must be task-owned");
   const baseline=JSON.parse(await fs.readFile(baselinePath,"utf8"));
   if(baseline.kind!=="main"||baseline.actualIntake?.sha256!==expectedSha||!baseline.managedUri)throw Error("Baseline did not create the expected real native intake reference");
   const baselineBytes=await fs.stat(baseline.nativeMediaPath);
   if(baselineBytes.size!==expectedBytes||await fileSha(baseline.nativeMediaPath)!==expectedSha)throw Error("Baseline media bytes changed");
   const imported=path.join(path.dirname(saved.path),path.basename(baseline.nativeMediaPath));
   await fs.copyFile(baseline.nativeMediaPath,imported,constants.COPYFILE_EXCL);
   if(buildInboundMediaUriFromPath(imported)!==baseline.managedUri)throw Error("Compatibility fixture changed the existing managed media URI");
   receipt.compatibility={sourceHead:baseline.sourceHead,managedUriUnchanged:true,bytesUnchanged:true,setup:"QA profile data clone retaining the exact existing native managed URI and bytes; no media/schema transformation"};
   await runStage("existing-main-managed-reference",128,64,baseline.managedUri,true);
  }
  });
 }});
 receipt.completedAt=new Date().toISOString();receipt.passed=true;
 await fs.writeFile(proof+"/"+run+"-"+kind+".private.json",JSON.stringify(receipt,null,2)+"\n",{mode:0o600,flag:"wx"});
 const publicReceipt=structuredClone(receipt);delete publicReceipt.nativeMediaPath;delete publicReceipt.managedUri;
 await fs.writeFile(proof+"/"+run+"-"+kind+".sanitized.json",JSON.stringify(publicReceipt,null,2)+"\n",{mode:0o600,flag:"wx"});
 console.log(JSON.stringify({passed:true,kind,cases:receipt.cases,receipt:proof+"/"+run+"-"+kind+".sanitized.json"}));
 process.exit(0);
}catch(error){
 receipt.passed=false;receipt.error=String(error);
 if(token)receipt.error=receipt.error.replaceAll(token,"[redacted]").replaceAll(token.replaceAll(":","~"),"[redacted]");
 await fs.writeFile(proof+"/"+run+"-"+kind+".failed.private.json",JSON.stringify(receipt,null,2)+"\n",{mode:0o600,flag:"wx"});
 console.error(receipt.error);process.exit(1);
}

