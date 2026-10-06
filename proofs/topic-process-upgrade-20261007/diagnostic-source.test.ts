// Disposable real-SQLite process upgrade diagnostic; no Telegram or connected-UI claim.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadSessionEntry, recordInboundSessionMeta, replaceSessionEntry } from "./session-accessor.js";
import { resolveGatewaySessionDisplayName } from "../../gateway/session-utils-display.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
const root=process.env.TOPIC_UPGRADE_PROOF_ROOT!;
const stateDir=path.join(root,"synthetic-state-canonical");
const storePath=path.join(stateDir,"agents","main","sessions","sessions.json");
const cases=[
  {thread:"77",sid:"synthetic-retained-new-chat",cached:"New Chat",topic:"Released topic",expected:"Released topic",account:"first-account"},
  {thread:"78",sid:"synthetic-retained-manual-label",cached:"New Chat",topic:"Released manual topic",label:"My manual GUI label",expected:"My manual GUI label",account:"first-account"},
  {thread:"79",sid:"synthetic-retained-other-account",cached:"New Chat",topic:"Released second account",expected:"Released second account",account:"second-account"},
];
const key=(thread:string)=>`agent:main:telegram:direct:42001:thread:${thread}`;
afterEach(async()=>{await closeOpenClawAgentDatabasesAsync();await closeOpenClawStateDatabaseAsync();vi.unstubAllEnvs();});
it("retains released session titles and explicit labels across source/process upgrade",async()=>{
  await fs.mkdir(path.dirname(storePath),{recursive:true});vi.stubEnv("OPENCLAW_STATE_DIR",stateDir);
  const phase=process.env.TOPIC_UPGRADE_PROOF_PHASE;
  if(phase==="seed"){
    for(const c of cases){
      const sessionKey=key(c.thread);
      await replaceSessionEntry({storePath,sessionKey},{sessionId:c.sid,updatedAt:123,displayName:c.cached,topicName:c.topic,...(c.label?{label:c.label}:{})});
      // Use the release's actual inbound metadata owner to persist canonical delivery.
      // The initial diagnostic incorrectly supplied retired top-level delivery fields.
      await recordInboundSessionMeta({storePath,sessionKey,createIfMissing:false,ctx:{Provider:"telegram",Surface:"telegram",ChatType:"direct",From:"telegram:direct:42001",To:"telegram:42001",AccountId:c.account,MessageThreadId:c.thread,SessionKey:sessionKey,ConversationLabel:"Synthetic Sender"}});
    }
    const entries=cases.map(c=>({key:key(c.thread),entry:loadSessionEntry({storePath,sessionKey:key(c.thread)})}));
    for(const [i,e] of entries.entries())expect(e.entry).toMatchObject({sessionId:cases[i].sid,updatedAt:123,displayName:"New Chat",topicName:cases[i].topic});
    await fs.writeFile(path.join(root,"seed-effect-receipt.json"),JSON.stringify({phase,pid:process.pid,entries},null,2));console.log("TOPIC_UPGRADE_SEED",process.pid,entries.length);
  }else if(phase==="read"){
    const seed=JSON.parse(await fs.readFile(path.join(root,"seed-effect-receipt.json"),"utf8"));expect(process.pid).not.toBe(seed.pid);
    const retained=cases.map(c=>({key:key(c.thread),entry:loadSessionEntry({storePath,sessionKey:key(c.thread)})}));expect(retained).toEqual(seed.entries);
    const observations=[];
    for(const c of cases){
      const sessionKey=key(c.thread);const before=loadSessionEntry({storePath,sessionKey});expect(resolveGatewaySessionDisplayName(sessionKey,before??undefined)).toBe(c.expected);
      const events: unknown[]=[];const stop=onSessionLifecycleEvent(e=>{if(e.sessionKey===sessionKey&&e.reason==="rename")events.push(e);});
      try{
        await recordInboundSessionMeta({storePath,sessionKey,createIfMissing:false,ctx:{Provider:"telegram",Surface:"telegram",ChatType:"direct",From:"telegram:direct:42001",To:"telegram:42001",AccountId:c.account,MessageThreadId:c.thread,SessionKey:sessionKey,ConversationLabel:"Synthetic Sender",ThreadLabel:"Renamed after upgrade "+c.thread}});
      }finally{stop();}
      const after=loadSessionEntry({storePath,sessionKey});expect(after).toMatchObject({sessionId:c.sid,updatedAt:123,displayName:"New Chat",topicName:"Renamed after upgrade "+c.thread});expect(events).toHaveLength(1);
      const displayed=resolveGatewaySessionDisplayName(sessionKey,after??undefined);expect(displayed).toBe(c.label??("Renamed after upgrade "+c.thread));
      observations.push({sessionIdPreserved:after?.sessionId===c.sid,activityPreserved:after?.updatedAt===123,cachedNameRetained:after?.displayName==="New Chat",initialDisplay:c.expected,finalDisplay:displayed,manualLabel:c.label??null,renameEvents:events.length});
    }
    await fs.writeFile(path.join(root,"reader-effect-receipt.json"),JSON.stringify({phase,pid:process.pid,seedPid:seed.pid,exactEntryReadback:true,observations},null,2));console.log("TOPIC_UPGRADE_READ",process.pid,observations.length);
  }else throw Error("Expected seed or read phase");
},60000);
