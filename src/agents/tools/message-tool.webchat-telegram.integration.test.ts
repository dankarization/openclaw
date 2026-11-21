import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { mirrorDeliveredReplyToTranscript } from "../../auto-reply/reply/dispatch-from-config.transcript.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readChatHistoryPage } from "../../gateway/server-methods/chat-history-pages.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { createMessageToolAsync } from "./message-tool-execution.js";
import {
  registerMessageChannel,
  stubMessageSecrets,
} from "./message-tool-execution.test-support.js";

const sessionKey = "agent:main:telegram:group:-100123:thread:topic:991:sender:42";
const sessionId = "webchat-telegram-session";
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});
const telegramSendText = telegramPlugin.outbound?.sendText;
if (!telegramSendText) {
  throw new Error("Missing shipped Telegram outbound adapter");
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

describe("WebChat source replies in a Telegram session", () => {
  it.each([
    { final: false, disabled: false, explicit: false },
    { final: true, disabled: false, explicit: false },
    { final: false, disabled: true, explicit: false },
    { final: false, disabled: false, explicit: true },
  ])(
    "handles final=$final opt-out=$disabled explicit=$explicit",
    async ({ final, disabled, explicit }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "webchat-telegram-" },
        async (state) => {
          const storePath = path.join(state.sessionsDir(), "sessions.json");
          const scope = { agentId: "main", sessionKey, sessionId, storePath };
          const config: OpenClawConfig = {
            agents: { entries: { main: {} } },
            session: { store: storePath },
            channels: { telegram: { enabled: true, accounts: { work: { enabled: true } } } },
            tools: { message: { crossContext: { allowWithinProvider: true } } },
          };
          const sendText = vi.fn(
            async (
              target: string,
              _text: string,
              _options: { messageThreadId?: number; accountId?: string },
            ) => {
              const messages = (await loadTranscriptEvents(scope)).map(readTranscriptEventMessage);
              expect(messages.filter((message) => message?.role === "assistant")).toHaveLength(
                explicit ? 0 : 1,
              );
              return { chatId: target, messageId: "external-1" };
            },
          );
          registerMessageChannel({
            ...createChannelTestPluginBase({
              id: "telegram",
              capabilities: { chatTypes: ["group"] },
              config: {
                listAccountIds: () => ["default", "work"],
                resolveAccount: () => ({ enabled: true }),
                isConfigured: () => true,
              },
            }),
            messaging: {
              normalizeTarget: (target) => target,
              targetResolver: { looksLikeId: () => true, hint: "chat id" },
            },
            outbound: {
              ...telegramPlugin.outbound,
              deliveryMode: "direct",
              sendPayload: undefined,
              sendText: (ctx) => telegramSendText({ ...ctx, deps: { telegram: sendText } }),
            },
          });
          setRuntimeConfigSnapshot(config);
          stubMessageSecrets();
          await replaceSessionEntry(scope, {
            sessionId,
            updatedAt: 1,
            delivery: {
              kind: "external",
              route: {
                channel: "telegram",
                accountId: "work",
                target: { to: "-100123", chatType: "group" },
                thread: { id: 991, kind: "topic" },
              },
              context: { channel: "telegram", to: "-100123", accountId: "work", threadId: 991 },
              origin: { provider: "telegram", chatType: "group" },
            },
          });
          const updates: SessionTranscriptUpdate[] = [];
          const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
          try {
            const tool = await createMessageToolAsync({
              config,
              agentId: "main",
              agentSessionKey: sessionKey,
              runSessionKey: sessionKey,
              sessionId,
              runId: `webchat-telegram-${final}`,
              currentChannelProvider: "webchat",
              sourceReplyDeliveryMode: "automatic",
              webchatExternalDeliveryDisabled: disabled,
            });
            const result = await tool.execute("send-reply", {
              action: "send",
              message: "Visible on both surfaces",
              final,
              ...(!explicit && !final ? { topLevel: false } : {}),
              ...(explicit ? { channel: "telegram", target: "-100999", threadId: "77" } : {}),
            });
            expect(sendText).toHaveBeenCalledTimes(disabled ? 0 : 1);
            if (!disabled) {
              expect(sendText.mock.calls[0]?.[0]).toBe(explicit ? "-100999" : "-100123");
              expect(sendText.mock.calls[0]?.[2]).toMatchObject({
                messageThreadId: explicit ? 77 : 991,
                accountId: explicit ? "default" : "work",
              });
            }
            const assistants = (await loadTranscriptEvents(scope))
              .map(readTranscriptEventMessage)
              .filter((message) => message?.role === "assistant");
            expect(assistants).toHaveLength(explicit ? 0 : 1);
            if (!explicit) {
              const sourceReply = extractMessagingToolSourceReplyPayload(result);
              expect(sourceReply).toMatchObject({
                text: "Visible on both surfaces",
                transcriptOwner: true,
                idempotencyKey: expect.any(String),
              });
              const payloads = buildEmbeddedRunPayloads({
                assistantTexts: [],
                lastAssistant: undefined,
                currentAssistant: undefined,
                sessionKey,
                agentId: "main",
                sourceReplyDeliveryMode: "message_tool_only",
                messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
                runId: `webchat-telegram-${final}`,
                verboseLevel: "off",
                reasoningLevel: "off",
                toolResultFormat: "plain",
              });
              const mirror = getReplyPayloadMetadata(
                payloads[0] as object,
              )?.sourceReplyTranscriptMirror;
              expect(mirror).toMatchObject({ transcriptOwner: true });
              await mirrorDeliveredReplyToTranscript({
                metadata: mirror
                  ? { ...mirror, expectedSessionId: sessionId, storePath }
                  : undefined,
                cfg: config,
              });
              expect(
                (await loadTranscriptEvents(scope))
                  .map(readTranscriptEventMessage)
                  .filter((message) => message?.role === "assistant"),
              ).toHaveLength(1);
              for (let reload = 0; reload < 2; reload += 1) {
                const page = await readChatHistoryPage({
                  entry: { sessionId, updatedAt: 1 },
                  provider: "openai",
                  sessionId,
                  storePath,
                  sessionAgentId: "main",
                  canonicalKey: sessionKey,
                  max: 20,
                  maxHistoryBytes: 1_000_000,
                  effectiveMaxChars: 10_000,
                  messageId: undefined,
                  ignoreCliSessionImports: true,
                });
                expect(
                  page.messages.filter((message) =>
                    JSON.stringify(message).includes("Visible on both surfaces"),
                  ),
                ).toHaveLength(1);
              }
              expect(assistants[0]?.content).toEqual([
                { type: "text", text: "Visible on both surfaces" },
              ]);
              expect(assistants[0]).toMatchObject({
                openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
              });
              expect(updates).toContainEqual(
                expect.objectContaining({
                  target: expect.objectContaining({ agentId: "main", sessionKey, sessionId }),
                  runId: `webchat-telegram-${final}`,
                  message: expect.objectContaining({
                    openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
                  }),
                }),
              );
            }
          } finally {
            unsubscribe();
          }
        },
      );
    },
  );

  it.each(["adapter", "secret", "topic", "zero-topic", "negative-topic", "account"] as const)(
    "retains the local reply when %s throws and reuses its receipt on retry",
    async (failure) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "webchat-telegram-error-" },
        async (state) => {
          const storePath = path.join(state.sessionsDir(), "sessions.json");
          const scope = { agentId: "main", sessionKey, sessionId, storePath };
          const config: OpenClawConfig = {
            agents: { entries: { main: {} } },
            session: { store: storePath },
            channels: { telegram: { enabled: true } },
          };
          const sendText = vi
            .fn()
            .mockResolvedValue({ chatId: "-100123", messageId: "external-1" });
          if (failure === "adapter") {
            sendText.mockRejectedValueOnce(new Error("telegram unavailable"));
          }
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
              sendText: (ctx) => telegramSendText({ ...ctx, deps: { telegram: sendText } }),
            },
          });
          setRuntimeConfigSnapshot(config);
          stubMessageSecrets();
          if (failure === "secret") {
            vi.mocked(
              commandSecretGateway.resolveCommandSecretRefsViaGateway,
            ).mockRejectedValueOnce(new Error("telegram unavailable"));
          }
          await replaceSessionEntry(scope, {
            sessionId,
            updatedAt: 1,
            delivery: {
              kind: "external",
              route: {
                channel: "telegram",
                accountId: "default",
                target: { to: "-100123", chatType: "group" },
                thread: { id: 991, kind: "topic" },
              },
              context: {
                channel: "telegram",
                to: "-100123",
                accountId: failure === "account" ? "work" : "default",
                threadId:
                  failure === "topic"
                    ? "topic:991:sender:42"
                    : failure === "zero-topic"
                      ? 0
                      : failure === "negative-topic"
                        ? -2
                        : 991,
              },
              origin: { provider: "telegram", chatType: "group" },
            },
          });
          const tool = await createMessageToolAsync({
            config,
            agentId: "main",
            agentSessionKey: sessionKey,
            runSessionKey: sessionKey,
            sessionId,
            runId: "failure-run",
            currentChannelProvider: "webchat",
            sourceReplyDeliveryMode: "automatic",
          });
          const args = { action: "send", message: "Still visible", final: false };
          await expect(tool.execute("first-attempt", args)).rejects.toThrow(
            failure === "topic" || failure === "zero-topic" || failure === "negative-topic"
              ? "saved Telegram topic is missing or invalid"
              : failure === "account"
                ? "saved Telegram account binding is inconsistent"
                : "telegram unavailable",
          );
          expect(
            (await loadTranscriptEvents(scope))
              .map(readTranscriptEventMessage)
              .filter((message) => message?.role === "assistant"),
          ).toHaveLength(1);
          if (
            failure === "topic" ||
            failure === "zero-topic" ||
            failure === "negative-topic" ||
            failure === "account"
          ) {
            expect(sendText).not.toHaveBeenCalled();
            return;
          }
          if (failure === "adapter") {
            await expect(tool.execute("retry-attempt", args)).rejects.toThrow(
              "Stable delivery intent is already queued",
            );
          } else {
            await tool.execute("retry-attempt", args);
          }
          expect(
            (await loadTranscriptEvents(scope))
              .map(readTranscriptEventMessage)
              .filter((message) => message?.role === "assistant"),
          ).toHaveLength(1);
          expect(sendText).toHaveBeenCalledTimes(1);
        },
      );
    },
  );
});
