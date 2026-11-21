import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  getSessionEntryByIdAsync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext as dispatchWithoutLabelDrain,
  generateTopicLabel,
  getSessionEntry,
  readTopicSourceMock,
  readTopicSourceActual,
  resolveStorePath,
  mockDefaultSessionEntry,
  prepareSkillCommandsForAgents,
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

import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";
import {
  getTopicLabelMetadata,
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

describeTelegramDispatch("Telegram generated topic refinement", () => {
  beforeEach(() => persistedSessionByStore.clear());
  const sessionKey = "agent:default:telegram:direct:123";
  let nextMessageId = 1000;
  const context = (text: string) => {
    const result = createContext();
    result.msg.message_id = nextMessageId++;
    result.ctxPayload = {
      ...result.ctxPayload,
      SessionKey: sessionKey,
      RawBody: text,
      CommandAuthorized: true,
    };
    return result;
  };
  const reply = () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Reply" }, { kind: "final" });
      return { queuedFinal: true };
    });
  };
  const persistedSessionByStore = new Map<string, string>();
  const seedSessionEntry = async (entry: Record<string, unknown>) => {
    const storePath = createContext().turn.storePath;
    const previousSessionId = persistedSessionByStore.get(storePath);
    const previous = previousSessionId
      ? await getSessionEntryByIdAsync({
          agentId: "default",
          storePath,
          sessionId: previousSessionId,
        })
      : undefined;
    const nextEntry = {
      ...previous?.entry,
      sessionId: String(entry.sessionId ?? previous?.entry.sessionId ?? "s1"),
      updatedAt: Date.now(),
      ...entry,
    } as Parameters<typeof upsertSessionEntry>[0]["entry"];
    persistedSessionByStore.set(storePath, nextEntry.sessionId);
    mockDefaultSessionEntry({ ...nextEntry });
    await upsertSessionEntry({
      agentId: "default",
      storePath,
      sessionKey,
      entry: nextEntry,
    });
  };

  it("renames through dispatch after six task follow-ups, once, including registered skills", async () => {
    prepareSkillCommandsForAgents.mockResolvedValue([
      { name: "review", skillName: "review", description: "Review the current task" },
    ]);
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    const opening = context("Plan the release");
    const scope = resolveTelegramDirectTopicNameCacheScope(opening.turn.storePath, "default");
    await seedSessionEntry({ sessionId: "s1" });
    await dispatchWithContext({ context: opening, bot });
    await vi.waitFor(() =>
      expect(editForumTopic).toHaveBeenLastCalledWith(123, 777, { name: "Topic label" }),
    );
    await seedSessionEntry({ sessionId: "s1", systemSent: true });
    generateTopicLabel.mockResolvedValue("Fix release signing");
    await dispatchWithContext({
      context: { ...context("/review disabled task"), skillFilter: ["another-skill"] },
      bot,
    });
    let fifthFollowup: ReturnType<typeof context> | undefined;
    for (const text of ["/status", "/unknown task", ...Array<string>(5).fill("/review signing")]) {
      const followup = context(text);
      await dispatchWithContext({ context: followup, bot });
      if (text === "/review signing") {
        fifthFollowup = followup;
      }
    }
    await vi.waitFor(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.seenMessageIds).toContain(
        String(fifthFollowup?.msg.message_id),
      ),
    );
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await dispatchWithContext({ context: context("Fix the certificate"), bot });
    await vi.waitFor(() =>
      expect(editForumTopic).toHaveBeenLastCalledWith(123, 777, {
        name: "Fix release signing",
      }),
    );
    expect(editForumTopic).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 7; index++) {
      await dispatchWithContext({ context: context("More detail"), bot });
    }
    const { waitForPendingTopicLabelsForTests } =
      await import("./bot-message-dispatch-topic-label.js");
    await waitForPendingTopicLabelsForTests();
    const completed = (await getTopicLabelMetadata(123, 777, scope))?.labelState;
    expect(completed?.phase).toBe("completed");
    expect(completed?.seenMessageIds).toHaveLength(7);
    expect(editForumTopic).toHaveBeenCalledTimes(2);
  });

  it("preserves a manual rename during inference", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    const initial = context("Plan the release");
    const scope = resolveTelegramDirectTopicNameCacheScope(initial.turn.storePath, "default");
    await seedSessionEntry({ sessionId: "s1" });
    await dispatchWithContext({ context: initial, bot });
    await vi.waitFor(() => expect(editForumTopic).toHaveBeenCalledTimes(1));
    await seedSessionEntry({ sessionId: "s1", systemSent: true });
    for (let index = 0; index < 5; index++) {
      await dispatchWithContext({ context: context("Signing problem"), bot });
    }
    generateTopicLabel.mockImplementationOnce(async () => {
      await updateTopicName(123, 777, { name: "My release" }, scope);
      return "Fix release signing";
    });
    await dispatchWithContext({ context: context("Fix it"), bot });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect(await getTopicLabelMetadata(123, 777, scope)).toMatchObject({ name: "My release" }),
    );
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it.each(["throws", "returns empty"] as const)(
    "retries a pending refinement after a provider that %s using the original snapshot",
    async (failure) => {
      reply();
      const bot = createBot();
      const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
      await seedSessionEntry({ sessionId: "s1" });
      await dispatchWithContext({ context: context("Opening task"), bot });
      await seedSessionEntry({ sessionId: "s1", systemSent: true });
      for (let index = 0; index < 5; index++) {
        await dispatchWithContext({ context: context("Opening follow-up " + index), bot });
      }

      const trigger = context("Opening follow-up five");
      const failedMessageId = trigger.msg.message_id;
      if (failure === "throws") {
        generateTopicLabel.mockRejectedValueOnce(new Error("provider unavailable"));
      } else {
        generateTopicLabel.mockResolvedValueOnce("");
      }
      await dispatchWithContext({ context: trigger, bot });
      const scope = resolveTelegramDirectTopicNameCacheScope(trigger.turn.storePath, "default");
      await vi.waitFor(async () =>
        expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
          phase: "pending",
          remainingMessages: 0,
        }),
      );
      const afterFailure = await getTopicLabelMetadata(123, 777, scope);
      expect(afterFailure?.labelState).toMatchObject({
        phase: "pending",
        remainingMessages: 0,
        inputMessages: [
          "Opening task",
          "Opening follow-up 0",
          "Opening follow-up 1",
          "Opening follow-up 2",
          "Opening follow-up 3",
          "Opening follow-up 4",
          "Opening follow-up five",
        ],
      });
      const failedCall = generateTopicLabel.mock.calls.at(-1)?.[0] as
        | { userMessage?: string }
        | undefined;
      expect(failedCall?.userMessage).toContain("Opening task");
      expect(failedCall?.userMessage).toContain("Opening follow-up five");
      const capturedSnapshot = failedCall?.userMessage;
      expect(afterFailure?.labelState?.capturedSource).toBe(capturedSnapshot);
      const attemptsAfterFailure = generateTopicLabel.mock.calls.length;

      const duplicate = context("duplicate delivery");
      duplicate.msg.message_id = failedMessageId;
      await dispatchWithContext({ context: duplicate, bot });

      generateTopicLabel.mockResolvedValueOnce("Topic label");
      await dispatchWithContext({ context: context("Next distinct follow-up"), bot });
      await vi.waitFor(async () =>
        expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
          phase: "completed",
          remainingMessages: 0,
        }),
      );
      expect(generateTopicLabel).toHaveBeenCalledTimes(attemptsAfterFailure + 1);
      const retryCall = generateTopicLabel.mock.calls.at(-1)?.[0] as
        | { userMessage?: string }
        | undefined;
      expect(retryCall?.userMessage).toBe(capturedSnapshot);
      const completed = await getTopicLabelMetadata(123, 777, scope);
      expect(completed?.labelState).toMatchObject({
        phase: "completed",
        remainingMessages: 0,
        inputMessages: afterFailure?.labelState?.inputMessages,
      });
      expect(completed?.labelState?.seenMessageIds).toContain(String(failedMessageId));
      expect(editForumTopic).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry a pending refinement over a later manual Telegram topic rename", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    await seedSessionEntry({ sessionId: "s1" });
    const initial = context("Opening task");
    const scope = resolveTelegramDirectTopicNameCacheScope(initial.turn.storePath, "default");
    await dispatchWithContext({ context: initial, bot });
    await vi.waitFor(() => expect(editForumTopic).toHaveBeenCalledTimes(1));
    await seedSessionEntry({ sessionId: "s1", systemSent: true });
    for (let index = 0; index < 5; index++) {
      await dispatchWithContext({ context: context("Follow-up " + index), bot });
    }
    generateTopicLabel.mockRejectedValueOnce(new Error("provider unavailable"));
    await dispatchWithContext({ context: context("Sixth follow-up"), bot });
    await vi.waitFor(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
        phase: "pending",
      }),
    );
    const callsAfterFailure = generateTopicLabel.mock.calls.length;
    await updateTopicName(123, 777, { name: "Manual Telegram title" }, scope);
    await dispatchWithContext({ context: context("Next distinct turn"), bot });
    await vi.waitFor(async () =>
      expect(await getTopicLabelMetadata(123, 777, scope)).toMatchObject({
        name: "Manual Telegram title",
        labelState: { phase: "completed" },
      }),
    );
    expect(generateTopicLabel).toHaveBeenCalledTimes(callsAfterFailure);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    const metadata = await getTopicLabelMetadata(123, 777, scope);
    expect(metadata?.name).toBe("Manual Telegram title");
    expect(metadata?.labelState).toMatchObject({
      phase: "completed",
      topicNameRevision: metadata?.nameRevision,
    });
  });

  it("retries after Telegram rename failure and keeps the prior title until the retry succeeds", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    await seedSessionEntry({ sessionId: "s1" });
    const initial = context("Opening task");
    const scope = resolveTelegramDirectTopicNameCacheScope(initial.turn.storePath, "default");
    await dispatchWithContext({ context: initial, bot });
    await vi.waitFor(() => expect(editForumTopic).toHaveBeenCalledTimes(1));
    await seedSessionEntry({ sessionId: "s1", systemSent: true });
    for (let index = 0; index < 5; index++) {
      await dispatchWithContext({ context: context("Follow-up " + index), bot });
    }
    generateTopicLabel.mockResolvedValueOnce("New release subject");
    editForumTopic.mockRejectedValueOnce(new Error("Telegram rename unavailable"));
    await dispatchWithContext({ context: context("Sixth follow-up"), bot });
    await vi.waitFor(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
        phase: "pending",
      }),
    );
    const afterRenameFailure = await getTopicLabelMetadata(123, 777, scope);
    expect(afterRenameFailure?.name).toBe("Topic label");
    expect(afterRenameFailure?.labelState).toMatchObject({ phase: "pending" });

    generateTopicLabel.mockResolvedValueOnce("Recovered release subject");
    await dispatchWithContext({ context: context("Next distinct follow-up"), bot });
    await vi.waitFor(async () =>
      expect(await getTopicLabelMetadata(123, 777, scope)).toMatchObject({
        name: "Recovered release subject",
        labelState: { phase: "completed" },
      }),
    );
    await vi.waitFor(() => expect(editForumTopic).toHaveBeenCalledTimes(3));
    const recovered = await getTopicLabelMetadata(123, 777, scope);
    expect(recovered?.name).toBe("Recovered release subject");
    expect(recovered?.labelState).toMatchObject({ phase: "completed" });
  });

  it("drops a transcript refinement when the same session id has a newer lifecycle revision", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    await seedSessionEntry({ sessionId: "s1", lifecycleRevision: "generation-1" });
    await dispatchWithContext({ context: context("Opening task"), bot });
    await seedSessionEntry({
      sessionId: "s1",
      lifecycleRevision: "generation-1",
      systemSent: true,
    });
    let fifthFollowup: ReturnType<typeof context> | undefined;
    for (let index = 0; index < 5; index++) {
      fifthFollowup = context("Follow-up " + index);
      await dispatchWithContext({ context: fifthFollowup, bot });
    }

    const scope = resolveTelegramDirectTopicNameCacheScope(
      createContext().turn.storePath,
      "default",
    );
    await vi.waitFor(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.seenMessageIds).toContain(
        String(fifthFollowup?.msg.message_id),
      ),
    );

    const attemptsBeforeRefinement = generateTopicLabel.mock.calls.length;
    const readSource = readTopicSourceActual;
    const originalReadSessionEntry = getSessionEntry.getMockImplementation()!;
    let sourceReadCompleted = false;
    let postResetEntry: Awaited<ReturnType<typeof originalReadSessionEntry>> | undefined;
    const latestEntryReadSpy = getSessionEntry.mockImplementation(async (...args) => {
      const entry = await originalReadSessionEntry(...args);
      if (
        sourceReadCompleted &&
        entry?.sessionId === "s1" &&
        entry.lifecycleRevision === "generation-2"
      ) {
        postResetEntry = entry;
      }
      return entry;
    });
    const readSourceSpy = readTopicSourceMock.mockImplementation(async (...args) => {
      await seedSessionEntry({ sessionId: "s1", lifecycleRevision: "generation-2" });
      const source = await readSource(...args);
      sourceReadCompleted = true;
      return source;
    });
    await dispatchWithContext({ context: context("Sixth follow-up"), bot });

    await vi.waitFor(() => expect(readSourceSpy).toHaveBeenCalledTimes(1));
    await readSourceSpy.mock.results.at(-1)?.value;
    await vi.waitFor(() =>
      expect(postResetEntry).toMatchObject({
        sessionId: "s1",
        lifecycleRevision: "generation-2",
      }),
    );
    // The post-read generation check is the last async operation before this
    // scheduler exits, so let its continuation finish before negative assertions.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(latestEntryReadSpy).toHaveBeenCalled();
    expect(generateTopicLabel).toHaveBeenCalledTimes(attemptsBeforeRefinement);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit custom session label aligned across both surfaces when the model suggests a replacement", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    const initial = context("Opening task");
    const scope = resolveTelegramDirectTopicNameCacheScope(initial.turn.storePath, "default");
    await seedSessionEntry({ sessionId: "s1", label: "Manual release title" });
    await updateTopicName(123, 777, { name: "Manual release title" }, scope);
    generateTopicLabel.mockResolvedValueOnce("Different release subject");
    await dispatchWithContext({ context: initial, bot });
    await vi.waitFor(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.seenMessageIds).toContain(
        String(initial.msg.message_id),
      ),
    );
    expect(generateTopicLabel).not.toHaveBeenCalled();
    for (let index = 0; index < 5; index++) {
      await dispatchWithContext({ context: context("Release detail " + index), bot });
    }
    await dispatchWithContext({ context: context("Release detail five"), bot });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.phase).toBe("completed"),
    );
    const call = generateTopicLabel.mock.calls.at(-1)?.[0] as { prompt?: string } | undefined;
    expect(call?.prompt).toContain("Manual release title");
    expect(call?.prompt).toContain("A manually chosen title is deliberate");
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).not.toHaveBeenCalled();
    const state = await getTopicLabelMetadata(123, 777, scope);
    expect(state?.labelState).toMatchObject({ phase: "completed" });
    expect(state?.name).toBe("Manual release title");
  });

  it("does not refine generated names belonging to a previous session", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    await seedSessionEntry({ sessionId: "s1" });
    await dispatchWithContext({ context: context("Plan the release"), bot });
    await vi.waitFor(() => expect(editForumTopic).toHaveBeenCalledTimes(1));
    await seedSessionEntry({ sessionId: "s2", systemSent: true });
    for (let index = 0; index < 7; index++) {
      await dispatchWithContext({ context: context("New conversation"), bot });
    }
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("preserves a manual name in the metadata owner's scope when the session uses another store", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    await seedSessionEntry({ sessionId: "s1" });
    const initial = context("Plan the release");
    const sessionStore = initial.turn.storePath;
    const ownerStore = sessionStore + ".account-owner";
    resolveStorePath.mockImplementation((...args: unknown[]) =>
      (args[1] as { agentId?: string } | undefined)?.agentId === "default"
        ? sessionStore
        : ownerStore,
    );
    const ownerScope = resolveTelegramDirectTopicNameCacheScope(ownerStore, "default");
    await updateTopicName(123, 777, { name: "My project" }, ownerScope);
    await dispatchWithContext({ context: initial, bot });
    expect(editForumTopic).not.toHaveBeenCalled();
  });
});
