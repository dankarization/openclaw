import { onAgentEvent as onGlobalAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
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

describeTelegramDispatch("Codex app-server to Telegram progress bridge", () => {
  it("sends the native command progress card to the current private forum topic", async () => {
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
      const message_id = 1401;
      visible.set(message_id, text);
      return {
        message_id,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Fixture" },
        text,
      };
    });
    const edit = vi
      .spyOn(bot.api, "editMessageText")
      .mockImplementation(async (_chatId, messageId, text) => {
        if (typeof text !== "string") {
          throw new Error("Expected a plain-text Telegram progress edit");
        }
        visible.set(messageId, text);
        return true;
      });
    const globalEvents: Array<{ runId: string; stream: string; data: Record<string, unknown> }> =
      [];
    const unsubscribe = onGlobalAgentEvent((event) => {
      globalEvents.push(event);
    });

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ replyOptions }: DispatchReplyWithBufferedBlockDispatcherArgs) => {
        const appServer = createStartedThreadHarness();
        const params = createTestParams();
        params.messageChannel = "telegram";
        params.currentChannelId = "123";
        params.currentThreadTs = "1001";
        params.onAssistantMessageStart = replyOptions?.onAssistantMessageStart;
        params.onPartialReply = replyOptions?.onPartialReply;
        // Production candidate runner supplies this generic handler as the direct attempt
        // callback; the Codex projector also publishes each event to the global bus.
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
          runId: "telegram-progress-bridge-test",
          notifyUserAboutCompaction: false,
          onCompactionCompleted: () => 0,
          messageToolDeliveryState: { toolCallIds: new Set(), completed: false },
        });

        const run = runCodexAppServerAttempt(params);
        await appServer.waitForMethod("turn/start");
        await appServer.notify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "commentary-1",
              phase: "commentary",
              text: "Checking the request",
              status: "inProgress",
            },
          },
        });
        await appServer.notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "commentary-1",
            delta: "Checking the request",
          },
        });
        await appServer.notify(
          itemNotification("item/started", {
            type: "commandExecution",
            id: "native-command-1",
            command: "printf progress",
            cwd: params.workspaceDir,
            status: "inProgress",
          }),
        );
        await draft?.flush();

        expect(send).toHaveBeenCalled();
        expect(edit).not.toHaveBeenCalled();
        expect([...visible.values()].join("\n")).toContain("Bash");
        expect(send.mock.calls[0]?.[0]).toBe(123);
        expect(send.mock.calls[0]?.[2]).toMatchObject({ message_thread_id: 1001 });
        expect(
          globalEvents.some(
            (event) =>
              event.runId === params.runId &&
              event.stream === "tool" &&
              event.data.phase === "start" &&
              event.data.toolCallId === "native-command-1",
          ),
        ).toBe(true);

        await appServer.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
        unsubscribe();
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
        streaming: { mode: "progress", progress: { toolProgress: true, commentary: true } },
      },
    });
    await vi.runOnlyPendingTimersAsync();
    expect([...visible.values()].join("\n")).toContain("Bash");
  });
});
