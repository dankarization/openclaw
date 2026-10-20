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
let receiptGeneration = 0;

const TaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: z.object({
    state: z.enum([
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_REJECTED",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_AUTH_REQUIRED",
      "submitted",
      "working",
      "completed",
      "failed",
      "canceled",
      "rejected",
      "input-required",
      "auth-required",
    ]),
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
      const previous = receipts.get(key);
      // A peer reusing an ID cannot transfer another session's read receipt.
      if (!previous || previous.source === source) {
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
