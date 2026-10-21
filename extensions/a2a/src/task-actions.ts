import { createHash } from "node:crypto";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { z } from "zod";
import { requestA2aPeer, resolveA2aOutboundPeer, sendA2aChannelText } from "./outbound.js";
import { extractA2aMessageText } from "./protocol.js";

type TaskReceipt = { source: string; contextId: string; createdAt: number };
const receipts = new Map<string, TaskReceipt>();
const MAX_RECEIPTS = 500;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Bound on the peer-supplied conversation context retained with a receipt. The value
 * comes from the remote task, so an unbounded copy would let one peer pin memory far
 * beyond the entry count cap; an over-long or non-printable value simply stores no
 * receipt, which fails the later read closed.
 */
const MAX_CONTEXT_ID_BYTES = 512;
let receiptGeneration = 0;

function isStorableContextId(value: string | undefined | null): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CONTEXT_ID_BYTES &&
    /^[\x20-\x7e]+$/.test(value)
  );
}

const TaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: z.object({
    // Conforming peers may report a state this build does not enumerate (for example
    // TASK_STATE_UNSPECIFIED); the reader normalizes any value and treats only the known
    // terminal states as terminal instead of rejecting the whole task.
    state: z.string().min(1),
    message: z.object({ parts: z.array(z.unknown()) }).optional(),
  }),
  artifacts: z.array(z.object({ parts: z.array(z.unknown()) })).optional(),
});

function sourceKey(ctx: ChannelMessageActionContext): string | undefined {
  return ctx.agentId && ctx.sessionKey && ctx.sessionId
    ? JSON.stringify([ctx.agentId, ctx.sessionKey, ctx.sessionId])
    : undefined;
}

function peerScope(ctx: ChannelMessageActionContext, to: string): string {
  const { accountId, peerName, peer } = resolveA2aOutboundPeer({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    to,
  });
  // Rotation or retargeting invalidates receipts; no credential is kept in the map.
  return createHash("sha256")
    .update(JSON.stringify([accountId, peerName, peer.url, peer.outboundToken ?? null]))
    .digest("hex");
}

function taskKey(scope: string, taskId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([scope, taskId]))
    .digest("hex");
}

function pruneReceipts(): void {
  for (const [key, receipt] of receipts) {
    if (Date.now() - receipt.createdAt >= RECEIPT_TTL_MS || receipts.size > MAX_RECEIPTS) {
      receipts.delete(key);
    }
  }
}

export function clearA2aTaskReadReceipts(): void {
  receiptGeneration += 1;
  receipts.clear();
}

export async function handleA2aTaskAction(ctx: ChannelMessageActionContext) {
  const to =
    readStringParam(ctx.params, "to") ?? readStringParam(ctx.params, "target", { required: true });
  if (!to) {
    throw new Error("A2A peer target is required");
  }
  if (ctx.action === "send") {
    const text = readStringParam(ctx.params, "message", { required: true });
    if (!text) {
      throw new Error("A2A task text is required");
    }
    const source = sourceKey(ctx);
    const generation = receiptGeneration;
    // Resolve before I/O; later configuration cannot rebind this accepted task.
    const scope = peerScope(ctx, to);
    if (ctx.dryRun) {
      return jsonResult({ to, dryRun: true, readAvailable: false });
    }
    const sent = await sendA2aChannelText({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      to,
      text,
      assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
    });
    let readAvailable = false;
    if (sent.taskId && source && generation === receiptGeneration) {
      const key = taskKey(scope, sent.taskId);
      // Prune before the collision lookup: an entry that outlived its TTL must not block
      // a replacement receipt for the same task ID.
      pruneReceipts();
      const previous = receipts.get(key);
      if (previous && previous.source !== source) {
        // A peer that reuses a task ID for another source must not leave the earlier
        // session able to read the replacement task: every send to a peer shares one
        // remote context, so the stale receipt would pass the source-independent
        // context check. Revoke it instead of retaining authority for the old source.
        receipts.delete(key);
      } else if (isStorableContextId(sent.contextId)) {
        receipts.set(key, { source, contextId: sent.contextId, createdAt: Date.now() });
        pruneReceipts();
        readAvailable = true;
      }
    }
    return jsonResult({ ...sent, readAvailable });
  }
  if (ctx.action !== "read") {
    throw new Error(`Unsupported A2A action: ${ctx.action}`);
  }
  const taskId = readStringParam(ctx.params, "messageId", { required: true });
  if (!taskId) {
    throw new Error("A2A read requires the remote task ID as messageId");
  }
  const assertAuthority = captureChannelReadAuthority();
  const key = taskKey(peerScope(ctx, to), taskId);
  pruneReceipts();
  const receipt = receipts.get(key);
  const directOperator = ctx.conversationReadOrigin === "direct-operator";
  const assertCurrent = () => {
    assertAuthority?.();
    ctx.assertDirectAdapterHandoff?.();
    pruneReceipts();
    if (
      !directOperator &&
      (!assertAuthority ||
        !receipt ||
        receipt.source !== sourceKey(ctx) ||
        receipts.get(key) !== receipt)
    ) {
      throw new Error(
        "A2A task read requires a SendMessage receipt from this exact agent/session incarnation and configured peer. Missing, expired or restarted receipts cannot be recovered from a task ID alone; ask an operator to reconcile, do not resend the task.",
      );
    }
  };
  assertCurrent();
  if (ctx.dryRun) {
    return jsonResult({ to, taskId, dryRun: true });
  }
  const response = await requestA2aPeer({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    to,
    method: "GetTask",
    rpcParams: { id: taskId },
    assertCurrent,
  });
  assertCurrent();
  const task = TaskSchema.safeParse(response.result);
  if (
    !task.success ||
    task.data.id !== taskId ||
    (!directOperator && receipt && task.data.contextId !== receipt.contextId)
  ) {
    throw new Error("A2A peer returned an invalid or mismatched task/context");
  }
  const state = task.data.status.state
    .replace(/^TASK_STATE_/, "")
    .replaceAll("-", "_")
    .toLowerCase();
  return jsonResult({
    to,
    taskId: task.data.id,
    contextId: task.data.contextId,
    state,
    terminal: ["completed", "failed", "canceled", "rejected"].includes(state),
    inputRequired: state === "input_required" || state === "auth_required",
    text:
      extractA2aMessageText(task.data.artifacts?.flatMap((artifact) => artifact.parts) ?? []) ?? "",
    ...(task.data.status.message
      ? { statusText: extractA2aMessageText(task.data.status.message.parts) ?? "" }
      : {}),
  });
}
