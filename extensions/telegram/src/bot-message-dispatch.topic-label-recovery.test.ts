import { AsyncWorkScope, getAsyncWorkSignal } from "openclaw/plugin-sdk/concurrency-runtime";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import {
  getSessionEntryByIdAsync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchWithContext as dispatchWithoutLabelDrain,
  dispatchReplyWithBufferedBlockDispatcher,
  generateTopicLabel,
  mockDefaultSessionEntry,
} from "./bot-message-dispatch.test-harness.js";

// Dispatch deliberately returns before detached naming. Own that phase explicitly
// before replacing provider responses or inspecting its persisted effects.
const dispatchWithContext = async (...args: Parameters<typeof dispatchWithoutLabelDrain>) => {
  const result = await dispatchWithoutLabelDrain(...args);
  const { waitForPendingTopicLabelsForTests } =
    await import("./bot-message-dispatch-topic-label.js");
  await waitForPendingTopicLabelsForTests();
  return result;
};

import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import {
  getTopicName,
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

const topicContext = (RawBody: string, ThreadLabel: string, accountId = "default", extra = {}) =>
  createContext({
    accountId,
    ctxPayload: { ...createContext().ctxPayload, RawBody, ThreadLabel, ...extra },
  });
const replyWith = (text: string) =>
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text }, { kind: "final" });
    return { queuedFinal: true };
  });
const persistedSessionByStore = new Map<string, string>();
const seedSessionEntry = async (entry: Record<string, unknown>) => {
  const context = createContext();
  const previousSessionId = persistedSessionByStore.get(context.turn.storePath);
  const previous = previousSessionId
    ? await getSessionEntryByIdAsync({
        agentId: context.route.agentId,
        storePath: context.turn.storePath,
        sessionId: previousSessionId,
      })
    : undefined;
  const nextEntry = {
    ...previous?.entry,
    sessionId: String(entry.sessionId ?? previous?.entry.sessionId ?? "s1"),
    updatedAt: Date.now(),
    ...entry,
  } as Parameters<typeof upsertSessionEntry>[0]["entry"];
  persistedSessionByStore.set(context.turn.storePath, nextEntry.sessionId);
  mockDefaultSessionEntry({ ...nextEntry });
  await upsertSessionEntry({
    agentId: context.route.agentId,
    storePath: context.turn.storePath,
    sessionKey: context.ctxPayload.SessionKey!,
    entry: nextEntry,
  });
};

describeTelegramDispatch("DM topic label recovery", () => {
  beforeEach(() => persistedSessionByStore.clear());
  afterEach(() => vi.restoreAllMocks());
  const http = useTelegramHttpFixture();
  it("names from the first real message after a command, outside the closed turn scope", async () => {
    replyWith("Done");
    const afterTurnClosed = Promise.withResolvers<void>();
    generateTopicLabel.mockImplementation(async () => {
      await afterTurnClosed.promise;
      getAsyncWorkSignal()?.throwIfAborted();
      return "Invoice review";
    });
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    const command = topicContext("/model", "New Thread", "default", { CommandSource: "text" });
    await seedSessionEntry({ sessionId: "s1" });
    await dispatchWithContext({ context: command, bot, streamMode: "off" });
    expect(generateTopicLabel).not.toHaveBeenCalled();
    const turn = new AsyncWorkScope();
    const real = topicContext("/tmp/report.csv summarize", "New Thread");
    await seedSessionEntry({ sessionId: "s1" });
    await turn.track(() => dispatchWithoutLabelDrain({ context: real, bot, streamMode: "off" }));
    await turn.drain();
    afterTurnClosed.resolve();
    const { waitForPendingTopicLabelsForTests } =
      await import("./bot-message-dispatch-topic-label.js");
    await waitForPendingTopicLabelsForTests();
    await vi.waitFor(() => expect(edit).toHaveBeenCalledWith(123, 777, { name: "Invoice review" }));
  });
  it("preserves an explicit topic-edit after failed labeling without a service-message echo", async () => {
    const cfg = {
      ...http.cfg,
      channels: {
        telegram: {
          ...http.cfg.channels.telegram,
          accounts: { alerts: { botToken: "654321:topic-recovery-fixture" } },
          actions: { editForumTopic: true },
        },
      },
    };
    const scope = resolveTelegramDirectTopicNameCacheScope(
      createContext().turn.storePath,
      "alerts",
    );
    await updateTopicName(123, 777, { name: "New Thread" }, scope);
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    const context = () => topicContext("Review an invoice", "New Thread", "alerts");
    await seedSessionEntry({ sessionId: "s1" });
    replyWith("Invoice details");
    const modelStarted = Promise.withResolvers<void>();
    const manualEditFinished = Promise.withResolvers<void>();
    generateTopicLabel.mockResolvedValueOnce(null).mockImplementationOnce(async () => {
      modelStarted.resolve();
      await manualEditFinished.promise;
      return "Invoice review";
    });
    await dispatchWithContext({ context: context(), cfg, bot, streamMode: "off" });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
    await seedSessionEntry({ sessionId: "s1", systemSent: true });
    const skipLog = vi.spyOn(runtimeEnv, "logVerbose");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
        await modelStarted.promise;
        const { handleTelegramAction } = await import("./action-runtime.js");
        await handleTelegramAction(
          {
            action: "topic-edit",
            chatId: "123",
            threadId: 777,
            name: "Manual invoice title",
            accountId: "alerts",
          },
          cfg,
        );
        manualEditFinished.resolve();
        await dispatcherOptions.deliver({ text: "Renamed the topic" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    await dispatchWithContext({ context: context(), cfg, bot, streamMode: "off" });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(skipLog).toHaveBeenCalledWith("auto-topic-label: stale naming result skipped"),
    );
    expect(http.requests).toEqual([
      {
        method: "editForumTopic",
        fields: { chat_id: "123", message_thread_id: 777, name: "Manual invoice title" },
      },
    ]);
    expect(await getTopicName(123, 777, scope)).toBe("Manual invoice title");
    expect(edit).not.toHaveBeenCalled();
  });

  it.each(["empty", "model error", "Telegram error"])(
    "retries after %s even when the reply has already completed",
    async (failure) => {
      replyWith("Invoice details");
      generateTopicLabel.mockImplementationOnce(async () => {
        if (failure === "model error") {
          throw new Error("model unavailable");
        }
        return failure === "empty" ? null : "Invoice review";
      });
      generateTopicLabel.mockResolvedValue("Invoice review");
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      if (failure === "Telegram error") {
        edit.mockRejectedValueOnce(new Error("edit unavailable"));
      }
      const scope = resolveTelegramDirectTopicNameCacheScope(
        createContext().turn.storePath,
        "default",
      );
      await updateTopicName(123, 777, { name: "New Thread" }, scope);
      const context = () => topicContext("Review an invoice", "New Thread");
      await seedSessionEntry({ sessionId: "s1" });
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
      if (failure === "Telegram error") {
        await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
      }
      await seedSessionEntry({ sessionId: "s1", systemSent: true });
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () =>
        expect(await getTopicName(123, 777, scope)).toBe("Invoice review"),
      );
      const context2 = topicContext("Check the total", "Invoice review");
      await dispatchWithContext({ context: context2, bot, streamMode: "off" });
      expect(generateTopicLabel).toHaveBeenCalledTimes(2);
      expect(edit).toHaveBeenLastCalledWith(123, 777, { name: "Invoice review" });
    },
  );
});
