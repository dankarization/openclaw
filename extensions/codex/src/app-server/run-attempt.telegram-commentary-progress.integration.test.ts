import { expect, it, vi } from "vitest";
import { createAgentRunEventHandler } from "../../../../src/auto-reply/reply/agent-runner-event-handler.js";
import type { AgentTurnParams } from "../../../../src/auto-reply/reply/agent-runner-execution.types.js";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
} from "../../../telegram/src/bot-message-dispatch.test-harness.js";
import type { DispatchReplyWithBufferedBlockDispatcherArgs } from "../../../telegram/src/bot-message-dispatch.test-harness.js";
import type * as TelegramDeliveryModule from "../../../telegram/src/bot/delivery.replies.js";
import type { TelegramDraftStream } from "../../../telegram/src/draft-stream.js";
import type * as TelegramDraftModule from "../../../telegram/src/draft-stream.js";
import type * as TelegramEditModule from "../../../telegram/src/send-edit.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describeTelegramDispatch("Codex commentary to Telegram progress bridge", () => {
  it("renders native commentary with tool progress disabled", async () => {
    vi.useFakeTimers();
    const actualDraft = await vi.importActual<typeof TelegramDraftModule>(
      "../../../telegram/src/draft-stream.js",
    );
    const actualDelivery = await vi.importActual<typeof TelegramDeliveryModule>(
      "../../../telegram/src/bot/delivery.replies.js",
    );
    const actualEdit = await vi.importActual<typeof TelegramEditModule>(
      "../../../telegram/src/send-edit.js",
    );
    deliverReplies.mockImplementation(actualDelivery.deliverStructuredReplies);
    editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);

    const bot = createBot();
    let draft: TelegramDraftStream | undefined;
    createTelegramDraftStream.mockImplementation((params) => {
      draft = actualDraft.createTelegramDraftStream(params);
      return draft;
    });
    const visible = new Map<number, string>();
    const send = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (_chatId, text) => {
      const message_id = 1402;
      visible.set(message_id, text);
      return {
        message_id,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Fixture" },
        text,
      };
    });
    vi.spyOn(bot.api, "editMessageText").mockImplementation(async (_chatId, messageId, text) => {
      if (typeof text !== "string") {
        throw new Error("Expected a plain-text Telegram progress edit");
      }
      visible.set(messageId, text);
      return true;
    });

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ replyOptions }: DispatchReplyWithBufferedBlockDispatcherArgs) => {
        const appServer = createStartedThreadHarness();
        const params = createTestParams();
        params.messageChannel = "telegram";
        params.currentChannelId = "123";
        params.currentThreadTs = "1001";
        params.runId = "telegram-commentary-progress-test";
        params.onAssistantMessageStart = replyOptions?.onAssistantMessageStart;
        params.onPartialReply = replyOptions?.onPartialReply;
        params.onAgentEvent = createAgentRunEventHandler({
          turn: {
            opts: replyOptions,
            sessionCtx: { MessageSid: "456", MessageSidFull: "456" },
            typingSignals: { signalToolStart: async () => undefined },
            toolProgressDetail: "raw",
          } as unknown as AgentTurnParams,
          lifecycleBackstop: { note: vi.fn() } as never,
          notifyAgentRunStart: vi.fn(),
          sourceRepliesAreToolOnly: false,
          provider: "openai",
          model: "codex-test",
          runId: params.runId,
          notifyUserAboutCompaction: false,
          onCompactionCompleted: () => 0,
          messageToolDeliveryState: { toolCallIds: new Set(), completed: false },
        });

        const run = runCodexAppServerAttempt(params);
        await appServer.waitForMethod("turn/start");
        const commentary = {
          type: "agentMessage",
          id: "commentary-only-1",
          phase: "commentary",
          text: "",
        };
        await appServer.notify(
          itemNotification("item/started", { ...commentary, status: "inProgress" }),
        );
        await appServer.notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "commentary-only-1",
            delta: "Checking the native Codex turn",
          },
        });
        await appServer.notify(
          itemNotification("item/completed", {
            ...commentary,
            text: "Checking the native Codex turn",
            status: "completed",
          }),
        );
        await draft?.flush();

        expect(send).toHaveBeenCalled();
        expect([...visible.values()].join("\n")).toContain("Checking the native Codex turn");
        expect([...visible.values()].join("\n")).toContain("💬");
        expect([...visible.values()].join("\n")).not.toContain("Bash");
        expect(send.mock.calls[0]?.[2]).toMatchObject({ message_thread_id: 1001 });

        await appServer.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      bot,
      cfg: { channels: { telegram: { botToken: "test-token" } } },
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
        msg: { chat: { id: 123, type: "private" }, message_id: 456, message_thread_id: 1001 },
        threadSpec: { id: 1001, scope: "dm" },
        replyThreadId: 1001,
        isGroup: false,
        route: { agentId: "fixture", accountId: "fixture" },
      }),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: false, commentary: true } },
      },
    });
    await vi.runOnlyPendingTimersAsync();
    expect([...visible.values()].join("\n")).toContain("Checking the native Codex turn");
  });
});
