// Transcript echo tests cover destination resolution, custom formatting,
// channel filtering, metadata forwarding, and failure swallowing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";

const { mockDeliverOutboundPayloads, resolveReplyDeliveryAccountIdMock, resolveReplyToModeMock } =
  vi.hoisted(() => ({
    mockDeliverOutboundPayloads: vi.fn(),
    resolveReplyDeliveryAccountIdMock: vi.fn(),
    resolveReplyToModeMock: vi.fn(),
  }));

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../auto-reply/reply/reply-threading.js", () => ({
  resolveReplyDeliveryAccountId: (...args: unknown[]) => resolveReplyDeliveryAccountIdMock(...args),
  resolveReplyToMode: (...args: unknown[]) => resolveReplyToModeMock(...args),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) =>
    channel === "voicechat" || channel === "telegram",
}));

import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";

const EMPTY_CONFIG = {} as OpenClawConfig;

function createCtx(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "voicechat",
    From: "+10000000001",
    AccountId: "acc1",
    ...overrides,
  };
}

describe("sendTranscriptEcho", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "voicechat", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
    resolveReplyDeliveryAccountIdMock.mockReset();
    resolveReplyDeliveryAccountIdMock.mockReturnValue("acc1");
    resolveReplyToModeMock.mockReset();
    resolveReplyToModeMock.mockReturnValue("all");
  });

  it("sends the default formatted transcript to the resolved origin", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+10000000001",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("uses a custom format when provided", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "custom message",
      format: "🎙️ Heard: {transcript}",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+10000000001",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: "🎙️ Heard: custom message" }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("keeps dollar sequences in the transcript literal", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "tickets cost $$40, wait for the deal & confirm with $&",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: '📝 "tickets cost $$40, wait for the deal & confirm with $&"' }],
      }),
    );
  });

  it("skips non-deliverable channels", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ Provider: "internal-system", From: "some-source" }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no resolved destination", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: undefined }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("prefers OriginatingTo when From is absent", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: "+19999999999" }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+19999999999",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("forwards Telegram account and thread metadata to outbound delivery", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        AccountId: "primary",
        MessageThreadId: 77,
      }),
      cfg: EMPTY_CONFIG,
      transcript: "threaded voice note",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "telegram",
      to: "telegram:42",
      accountId: "primary",
      threadId: 77,
      payloads: [
        { text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "threaded voice note") },
      ],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("passes the source id through implicit reply policy when threading is enabled", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        MessageSid: "501",
        MessageSidFull: "telegram:42:501",
      }),
      cfg: EMPTY_CONFIG,
      transcript: "reply target voice note",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:42",
        replyToId: "telegram:42:501",
        replyToMode: "all",
        payloads: [
          {
            text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "reply target voice note"),
          },
        ],
      }),
    );
  });

  it("preserves single-use mode for inferred MessageSid replies", async () => {
    resolveReplyToModeMock.mockReturnValue("first");
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        MessageSid: "501",
      }),
      cfg: EMPTY_CONFIG,
      transcript: "short sid voice note",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "501",
        replyToMode: "first",
        payloads: [
          {
            text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "short sid voice note"),
          },
        ],
      }),
    );
  });

  it("omits automatically inferred replies when channel threading is off", async () => {
    resolveReplyToModeMock.mockReturnValue("off");
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        MessageSid: "501",
      }),
      cfg: EMPTY_CONFIG,
      transcript: "unthreaded voice note",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.not.objectContaining({
        replyToId: expect.anything(),
        replyToMode: expect.anything(),
      }),
    );
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [
          {
            text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "unthreaded voice note"),
          },
        ],
      }),
    );
  });

  it("omits replyToId when the source message id is unknown", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ Provider: "telegram", From: undefined, OriginatingTo: "telegram:42" }),
      cfg: EMPTY_CONFIG,
      transcript: "anonymous voice note",
    });

    const call = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as { payloads: unknown[] };
    expect(call).toBeDefined();
    expect(call.payloads[0]).toEqual({
      text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "anonymous voice note"),
    });
  });

  it("swallows delivery failures", async () => {
    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    await expect(
      sendTranscriptEcho({
        ctx: createCtx(),
        cfg: EMPTY_CONFIG,
        transcript: "hello world",
      }),
    ).resolves.toBeUndefined();
  });
});
