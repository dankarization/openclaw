import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTelegramSubagentTyping } from "../subagent-typing-api.js";
import { TELEGRAM_CHAT_ACTION_INTERVAL_MS } from "./chat-action-timing.js";

const sendRuntimeMocks = vi.hoisted(() => ({
  sendTypingTelegram: vi.fn(async () => undefined),
}));

// mock-isolation: Detached typing tests must not open a Telegram send runtime or Bot API socket.
vi.mock("./send-runtime.js", () => ({
  loadTelegramSendModule: async () => ({
    sendTypingTelegram: sendRuntimeMocks.sendTypingTelegram,
  }),
}));

describe("Telegram detached-subagent typing integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendRuntimeMocks.sendTypingTelegram.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts, renews, and stops route typing through the plugin hook", async () => {
    let progressHandler: ((event: ReturnType<typeof progressEvent>) => void) | undefined;
    const registerRuntimeLifecycle = vi.fn();
    const api = createTestPluginApi({
      id: "telegram",
      config: { agents: { defaults: { typingIntervalSeconds: 4 } } } as never,
      on: ((hookName, handler) => {
        if (hookName === "subagent_progress") {
          progressHandler = handler as (event: ReturnType<typeof progressEvent>) => void;
        }
      }) as OpenClawPluginApi["on"],
      registerRuntimeLifecycle,
    });
    registerTelegramSubagentTyping(api);

    progressHandler?.(progressEvent("started", "run-1"));
    progressHandler?.(progressEvent("started", "run-2"));
    await settleTyping();
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(2);

    progressHandler?.(progressEvent("ended", "run-1"));
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(3);

    progressHandler?.(progressEvent("ended", "run-2"));
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(3);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledWith(
      "telegram:group:-100123:topic:7",
      expect.objectContaining({ accountId: "work", messageThreadId: 7 }),
    );

    const lifecycle = registerRuntimeLifecycle.mock
      .calls[0]?.[0] as PluginRuntimeLifecycleRegistration;
    await lifecycle.cleanup?.({ reason: "reset", sessionKey: "agent:main:root" });

    progressHandler?.(progressEvent("started", "run-3"));
    await settleTyping();
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(4);

    progressHandler?.(progressEvent("ended", "run-3"));
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(4);

    await lifecycle.cleanup?.({ reason: "disable" });
  });

  it("does not start typing when the requester typing mode is never", async () => {
    const { progressHandler } = registerWithConfig({
      agents: {
        defaults: { typingMode: "never", typingIntervalSeconds: 10 },
      },
    });

    progressHandler?.(progressEvent("started", "quiet-policy"));
    await settleTyping();

    expect(sendRuntimeMocks.sendTypingTelegram).not.toHaveBeenCalled();
  });

  it("renews on the configured typing interval instead of the four-second transport floor", async () => {
    const { progressHandler } = registerWithConfig({
      agents: { defaults: { typingIntervalSeconds: 10 } },
    });

    progressHandler?.(progressEvent("started", "cadence"));
    await settleTyping();
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000 - TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(2);
  });

  it("does not allocate typing for quiet or internal child runs", async () => {
    const { progressHandler } = registerWithConfig({});

    progressHandler?.(progressEvent("started", "quiet-child", { publicPresentation: false }));
    await settleTyping();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendRuntimeMocks.sendTypingTelegram).not.toHaveBeenCalled();
  });

  it("honors a requester agent typingMode override", async () => {
    const { progressHandler } = registerWithConfig({
      agents: {
        defaults: { typingMode: "instant" },
        entries: { research: { typingMode: "never" } },
      },
    });

    progressHandler?.(progressEvent("started", "agent-never"), {
      requesterSessionKey: "agent:research:main",
    });
    await settleTyping();

    expect(sendRuntimeMocks.sendTypingTelegram).not.toHaveBeenCalled();
  });

  it("keeps typing after session delete and stops allocating after plugin restart", async () => {
    const { progressHandler, lifecycle } = registerWithConfig({
      agents: { defaults: { typingIntervalSeconds: 4 } },
    });

    progressHandler?.(progressEvent("started", "before-delete"));
    await settleTyping();
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledOnce();
    progressHandler?.(progressEvent("ended", "before-delete"));

    await lifecycle?.cleanup?.({ reason: "delete", sessionKey: "agent:main:root" });
    progressHandler?.(progressEvent("started", "after-delete"));
    await settleTyping();
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(2);
    progressHandler?.(progressEvent("ended", "after-delete"));

    await lifecycle?.cleanup?.({ reason: "restart" });
    progressHandler?.(progressEvent("started", "after-restart"));
    await settleTyping();
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(2);
  });
});

function registerWithConfig(config: Record<string, unknown>) {
  let progressHandler:
    | ((event: ReturnType<typeof progressEvent>, ctx?: { requesterSessionKey?: string }) => void)
    | undefined;
  const registerRuntimeLifecycle = vi.fn();
  const api = createTestPluginApi({
    id: "telegram",
    config: config as never,
    on: ((hookName, handler) => {
      if (hookName === "subagent_progress") {
        progressHandler = handler as typeof progressHandler;
      }
    }) as OpenClawPluginApi["on"],
    registerRuntimeLifecycle,
  });
  registerTelegramSubagentTyping(api);
  const lifecycle = registerRuntimeLifecycle.mock.calls[0]?.[0] as
    | PluginRuntimeLifecycleRegistration
    | undefined;
  return { progressHandler, lifecycle };
}

async function settleTyping(): Promise<void> {
  await vi.dynamicImportSettled();
  await Promise.resolve();
  await Promise.resolve();
}

function progressEvent(
  phase: "started" | "ended",
  runId: string,
  extras?: { publicPresentation?: boolean },
) {
  return {
    phase,
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    publicPresentation: extras?.publicPresentation ?? true,
    requester: {
      channel: "telegram",
      accountId: "work",
      to: "telegram:group:-100123:topic:7",
      threadId: 7,
    },
  };
}
