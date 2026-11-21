import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createMessageToolAsync } from "../agents/tools/message-tool-execution.js";
import {
  registerMessageChannel,
  stubMessageSecrets,
} from "../agents/tools/message-tool-execution.test-support.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "./message-action-turn-capability.js";
import { createProductState } from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});

it("publishes and reloads a local source receipt when Telegram delivery throws", async () => {
  const state = await createProductState("webchat-telegram-receipt");
  const sessionKey = "agent:main:telegram:group:-100123:thread:topic:991:sender:42";
  const sessionId = "telegram-receipt-session";
  const runId = "telegram-receipt-run";
  const text = "Visible even when Telegram is unavailable.";
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    session: { store: storePath },
    channels: { telegram: { enabled: true } },
    plugins: { slots: { memory: "none" } },
    gateway: { auth: { mode: "token", token: "receipt-test" } },
  };
  const frames: unknown[] = [];
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let capability: string | undefined;
  try {
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token: "receipt-test",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        if (event.event === "session.message") frames.push(event.payload);
      },
    });
    await replaceSessionEntry(
      { agentId: "main", sessionKey, sessionId, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: {
            channel: "telegram",
            accountId: "default",
            target: { to: "-100123", chatType: "group" },
            thread: { id: 991, kind: "topic" },
          },
          context: { channel: "telegram", to: "-100123", accountId: "default", threadId: 991 },
          origin: { provider: "telegram", chatType: "group" },
        },
      },
    );
    await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
    const telegramSendText = telegramPlugin.outbound?.sendText;
    if (!telegramSendText) throw new Error("Missing Telegram adapter");
    const send = vi.fn(
      async (
        _target: string,
        _text: string,
        _options: { messageThreadId?: number; accountId?: string },
      ) => {
        throw new Error("telegram unavailable");
      },
    );
    registerMessageChannel({
      ...createChannelTestPluginBase({
        id: "telegram",
        capabilities: { chatTypes: ["group"] },
        config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
      }),
      messaging: {
        normalizeTarget: (target) => target,
        targetResolver: { looksLikeId: () => true, hint: "chat id" },
      },
      outbound: {
        ...telegramPlugin.outbound,
        deliveryMode: "direct",
        sendPayload: undefined,
        sendText: (ctx) => telegramSendText({ ...ctx, deps: { telegram: send } }),
      },
    });
    stubMessageSecrets();
    capability = mintMessageActionTurnCapability({
      agentId: "main",
      sessionKey,
      sessionId,
      runId,
      toolContext: {
        currentChannelProvider: "webchat",
        currentSourceTurnId: "webchat-source-turn",
      },
    });
    const tool = await createMessageToolAsync({
      config: cfg,
      agentId: "main",
      agentSessionKey: sessionKey,
      runSessionKey: sessionKey,
      sessionId,
      runId,
      currentChannelProvider: "webchat",
      messageActionTurnCapability: capability,
      sourceReplyDeliveryMode: "automatic",
    });
    await expect(
      tool.execute("send-failure", { action: "send", message: text, final: true }),
    ).rejects.toThrow("telegram unavailable");
    await vi.waitFor(
      () =>
        expect(
          frames.some(
            (frame) =>
              isRecord(frame) &&
              frame.sessionKey === sessionKey &&
              JSON.stringify(frame.message)?.includes(text),
          ),
        ).toBe(true),
      { timeout: 15_000 },
    );
    const published = frames.filter(
      (frame) =>
        isRecord(frame) &&
        frame.sessionKey === sessionKey &&
        JSON.stringify(frame.message)?.includes(text),
    );
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      message: { openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]).toMatchObject({ messageThreadId: 991, accountId: "default" });
    let lastHistory: unknown[] = [];
    for (let reload = 0; reload < 2; reload += 1) {
      const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      expect(
        history.messages.filter((message) => JSON.stringify(message).includes(text)),
      ).toHaveLength(1);
      lastHistory = history.messages;
    }
    if (process.env.OPENCLAW_TERRA_198785_PROOF) {
      await writeFile(
        process.env.OPENCLAW_TERRA_198785_PROOF,
        JSON.stringify({ sessionKey, runId, text, event: published[0], history: lastHistory }),
      );
    }
  } finally {
    if (capability) revokeMessageActionTurnCapability(capability);
    vi.restoreAllMocks();
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
    }
    await state.cleanup();
  }
}, 120_000);
