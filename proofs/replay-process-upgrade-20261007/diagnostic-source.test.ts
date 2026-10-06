// Disposable storage/process upgrade diagnostic. Channel delivery is a fake adapter, not Telegram proof.
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { enqueueDelivery, enqueueDeliveryOnce } from "../infra/outbound/delivery-queue-storage.js";
import path from "node:path";
import { setVerbose } from "../globals.js";
import { afterEach, expect, it, vi } from "vitest";
import { loadDeliveryQueueEntries, getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-media-staging.js";
import { recoverPendingDeliveries } from "../infra/outbound/delivery-queue-recovery.js";
import { createRecoveryLog } from "../infra/outbound/delivery-queue.test-helpers.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { sendTranscriptEcho } from "./echo-transcript.js";
const proofRoot = process.env.REPLAY_UPGRADE_PROOF_ROOT!;
const stateDir = path.join(proofRoot, "synthetic-state-storage-owner");
const sent: string[] = [];
function activate() {
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "diagnostic", plugin: createOutboundTestPlugin({ id: "telegram", outbound: { deliveryMode: "direct", sendText: async params => { await params.onPlatformSendDispatch?.(); sent.push(params.text); return {channel:"telegram",messageId:`synthetic-${sent.length}`}; } } }) }]));
}
function echo(sid: string, transcript: string) {
  return sendTranscriptEcho({cfg:{},ctx:{Provider:"telegram",AccountId:"synthetic-account",OriginatingTo:"telegram:-100123:topic:7",MessageThreadId:7,MessageSid:sid},transcript});
}
afterEach(async () => { await closeOpenClawStateDatabaseAsync(); setVerbose(false); resetPluginRuntimeStateForTest(); setActivePluginRegistry(createEmptyPluginRegistry()); vi.unstubAllEnvs(); });
it("preserves existing queue entries across separate old and new native processes", async () => {
  setVerbose(true); console.log("PROOF_STAGE",process.env.REPLAY_UPGRADE_PROOF_PHASE,"start"); await fs.mkdir(stateDir,{recursive:true}); vi.stubEnv("OPENCLAW_STATE_DIR",stateDir);
  const phase=process.env.REPLAY_UPGRADE_PROOF_PHASE;
  if(phase==="seed") {
    activate();
    console.log("PROOF_STAGE","before-completed-echo"); await echo("42","synthetic completed keyed echo"); console.log("PROOF_STAGE","completed-echo-returned");
    await sendDurableMessageBatchCore({cfg:{},channel:"telegram",to:"telegram:-100123",accountId:"synthetic-account",payloads:[{text:"synthetic existing other namespace"}],bestEffort:false,durability:"required",deliveryIntentId:"existing-release:completed",completionRetention:{idPrefix:"existing-release:",maxAgeMs:86400000,maxEntries:2000}});
    expect(sent).toHaveLength(2);
    // Storage-only fixture preparation: use the release's unchanged queue writer.
    // An empty plugin registry would cold-load the real Telegram plugin, not create a no-adapter row.
    const pendingKey = "transcript-echo:v1:" + createHash("sha256").update(JSON.stringify(["synthetic-account","-100123","43"])).digest("hex");
    await enqueueDeliveryOnce({channel:"telegram",to:"telegram:-100123:topic:7",accountId:"synthetic-account",threadId:7,payloads:[{text:'📝 "synthetic pending keyed echo"'}],queuePolicy:"required",bestEffort:false,completionRetention:{idPrefix:"transcript-echo:v1:",maxAgeMs:86400000,maxEntries:2000}},pendingKey,stateDir);
    await enqueueDelivery({channel:"telegram",to:"telegram:-100123",accountId:"synthetic-account",payloads:[{text:'📝 "synthetic pending released unkeyed echo"'}],queuePolicy:"best_effort",bestEffort:true},stateDir);
    const entries=loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME,stateDir,"all");
    const pending=entries.filter(e=>getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME,e.id,stateDir)==="pending");
    const completed=entries.filter(e=>getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME,e.id,stateDir)==="completed");
    expect(pending).toHaveLength(2);expect(completed).toHaveLength(2);
    expect(pending.some(e=>e.id.startsWith("transcript-echo:v1:"))).toBe(true);
    expect(pending.some(e=>!e.id.startsWith("transcript-echo:v1:"))).toBe(true);
    const receipt={phase,pid:process.pid,entries,pendingIds:pending.map(e=>e.id),completedIds:completed.map(e=>e.id),adapterCalls:sent.length};
    await fs.writeFile(path.join(proofRoot,"seed-effect-receipt.json"),JSON.stringify(receipt,null,2));
    console.log("REPLAY_UPGRADE_SEED",JSON.stringify({pid:process.pid,pending:pending.length,completed:completed.length}));
  } else if(phase==="read") {
    const seed=JSON.parse(await fs.readFile(path.join(proofRoot,"seed-effect-receipt.json"),"utf8"));
    expect(process.pid).not.toBe(seed.pid);
    const before=loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME,stateDir,"all");
    expect(before).toEqual(seed.entries);
    for(const id of seed.completedIds)expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME,id,stateDir)).toBe("completed");
    for(const id of seed.pendingIds)expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME,id,stateDir)).toBe("pending");
    activate(); await echo("42","synthetic completed keyed echo");expect(sent).toHaveLength(0);
    const summary=await recoverPendingDeliveries({cfg:{},deliver:deliverOutboundPayloads,log:createRecoveryLog(),stateDir});
    expect(summary).toMatchObject({recovered:2,failed:0});expect(sent).toHaveLength(2);
    await echo("43","synthetic pending keyed echo");expect(sent).toHaveLength(2);
    for(const id of seed.completedIds)expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME,id,stateDir)).toBe("completed");
    const remaining=loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME,stateDir);
    expect(remaining).toHaveLength(0);
    await fs.writeFile(path.join(proofRoot,"reader-effect-receipt.json"),JSON.stringify({phase,pid:process.pid,seedPid:seed.pid,unchangedEntryReadback:true,retainedCompletedReceipts:seed.completedIds.length,recoveredPending:summary.recovered,failed:summary.failed,adapterCalls:sent.length,completedKeyReplayAddedCalls:0,recoveredKeyReplayAddedCalls:0,remainingPending:remaining.length},null,2));
    console.log("REPLAY_UPGRADE_READ",JSON.stringify({pid:process.pid,recovered:summary.recovered,adapterCalls:sent.length,remainingPending:remaining.length}));
  } else throw Error("Expected seed or read proof phase");
},60000);
