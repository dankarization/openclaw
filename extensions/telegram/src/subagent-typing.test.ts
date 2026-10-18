// Telegram tests cover detached-subagent typing lifecycle behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_CHAT_ACTION_INTERVAL_MS,
  TELEGRAM_SUBAGENT_TYPING_MAX_DURATION_MS,
} from "./chat-action-timing.js";
import { createTelegramSubagentTyping } from "./subagent-typing.js";

function createController() {
  const sendTyping = vi.fn(async () => undefined);
  const onTypingError = vi.fn();
  const controller = createTelegramSubagentTyping({ sendTyping, onTypingError });
  return { controller, sendTyping };
}

const enabledPresentation = {
  enabled: true,
  intervalMs: TELEGRAM_CHAT_ACTION_INTERVAL_MS,
};

function startEvent(
  runId: string,
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  },
  publicPresentation = true,
) {
  return {
    phase: "started" as const,
    runId,
    publicPresentation,
    requester,
  };
}

function startRun(
  controller: ReturnType<typeof createTelegramSubagentTyping>,
  runId: string,
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  },
  presentation = enabledPresentation,
  publicPresentation = true,
) {
  controller.handle(startEvent(runId, requester, publicPresentation), presentation);
}

async function flushTypingStart(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Telegram detached-subagent typing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one route typing until its last concurrent child ends", async () => {
    const { controller, sendTyping } = createController();
    const requester = {
      channel: "telegram",
      accountId: "work",
      to: "telegram:group:-100123:topic:7",
      threadId: 7,
    };

    startRun(controller, "run-1", requester);
    startRun(controller, "run-1", requester);
    startRun(controller, "run-2", requester);
    await flushTypingStart();
    expect(sendTyping).toHaveBeenCalledOnce();

    controller.handle({ phase: "ended", runId: "run-1" });
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    controller.handle({ phase: "ended", runId: "run-2" });
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it("isolates typing by account, chat, and topic", async () => {
    const { controller, sendTyping } = createController();

    startRun(controller, "run-work", {
      channel: "telegram",
      accountId: "work",
      to: "-100123",
      threadId: 7,
    });
    startRun(controller, "run-ops", {
      channel: "telegram",
      accountId: "ops",
      to: "-100123",
      threadId: 7,
    });
    startRun(controller, "run-topic", {
      channel: "telegram",
      accountId: "work",
      to: "-100123",
      threadId: "8",
    });
    await flushTypingStart();

    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(sendTyping).toHaveBeenCalledWith({ accountId: "work", to: "-100123", threadId: 7 });
    expect(sendTyping).toHaveBeenCalledWith({ accountId: "ops", to: "-100123", threadId: 7 });
    expect(sendTyping).toHaveBeenCalledWith({
      accountId: "work",
      to: "-100123",
      threadId: "8",
    });
  });

  it("expires a run whose terminal event never arrives", async () => {
    const { controller, sendTyping } = createController();
    startRun(controller, "lost-run", { channel: "telegram", to: "42" });
    await flushTypingStart();

    await vi.advanceTimersByTimeAsync(TELEGRAM_SUBAGENT_TYPING_MAX_DURATION_MS);
    const callsAtExpiry = sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(callsAtExpiry).toBeGreaterThan(1);
    expect(sendTyping).toHaveBeenCalledTimes(callsAtExpiry);
  });

  it("ignores progress without a routable Telegram requester", async () => {
    const { controller, sendTyping } = createController();

    startRun(controller, "discord-run", { channel: "discord", to: "42" });
    startRun(controller, "missing-target", { channel: "telegram" });
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("ignores channel Direct Messages because Telegram does not support typing there", async () => {
    const { controller, sendTyping } = createController();

    startRun(controller, "direct-topic-run", {
      channel: "telegram",
      to: "telegram:group:-100123:direct-topic:77",
    });
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("stops all route timers when the plugin runtime is disposed", async () => {
    const { controller, sendTyping } = createController();
    startRun(controller, "run-1", { channel: "telegram", to: "42" });
    await flushTypingStart();
    expect(sendTyping).toHaveBeenCalledOnce();

    controller.dispose();
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(sendTyping).toHaveBeenCalledOnce();
  });

  it("does not start when typing is disabled or the run is not publicly eligible", async () => {
    const { controller, sendTyping } = createController();
    const requester = { channel: "telegram", to: "42" };

    startRun(controller, "never", requester, { enabled: false, intervalMs: 10_000 });
    startRun(controller, "quiet", requester, enabledPresentation, false);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("renews on the supplied cadence instead of the transport floor", async () => {
    const { controller, sendTyping } = createController();
    startRun(
      controller,
      "slow",
      { channel: "telegram", to: "42" },
      {
        enabled: true,
        intervalMs: 10_000,
      },
    );
    await flushTypingStart();
    expect(sendTyping).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendTyping).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000 - TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });
});
