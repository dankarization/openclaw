import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendTranscriptEchoMock, transcribeFirstAudioMock } = vi.hoisted(() => ({
  sendTranscriptEchoMock: vi.fn(),
  transcribeFirstAudioMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: (
      params: Parameters<typeof actual.createChannelPreflightAudio>[0],
    ) =>
      actual.createChannelPreflightAudio({
        ...params,
        resolveAudioPreflight: async ({ deferTranscriptEcho: _deferred, ...request }) => {
          const transcript = await transcribeFirstAudioMock(request);
          return transcript
            ? { transcript, identity: { provider: "whisper", requestedBackend: "cpu" } }
            : undefined;
        },
        sendTranscriptEcho: sendTranscriptEchoMock,
      }),
  };
});

import {
  isMatrixAudioContent,
  resolveMatrixPreflightAudioTranscript,
  sendMatrixPreflightAudioTranscriptEcho,
} from "./preflight-audio.js";

const cfg = {} as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;

describe("isMatrixAudioContent", () => {
  it("accepts Matrix audio messages and audio files", () => {
    expect(isMatrixAudioContent({ msgtype: "m.audio" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "audio/ogg" })).toBe(true);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "AUDIO/MP4" })).toBe(true);
  });

  it("rejects non-audio Matrix content", () => {
    expect(isMatrixAudioContent({ msgtype: "m.image", mimetype: "image/png" })).toBe(false);
    expect(isMatrixAudioContent({ msgtype: "m.file", mimetype: "application/pdf" })).toBe(false);
    expect(isMatrixAudioContent({ mimetype: "audio/ogg" })).toBe(false);
  });
});

describe("resolveMatrixPreflightAudioTranscript", () => {
  beforeEach(() => {
    sendTranscriptEchoMock.mockReset();
    transcribeFirstAudioMock.mockReset();
  });

  it("passes the Matrix-local media path to shared audio preflight", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello from voice");

    const transcript = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg,
      accountId: "ops",
      chatType: "channel",
      originatingTo: "room:!room:example.org",
      messageThreadId: "$thread",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          media: [{ path: "/tmp/inbound/voice.ogg", contentType: "audio/ogg" }],
          Provider: "matrix",
          Surface: "matrix",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:!room:example.org",
          AccountId: "ops",
          MessageThreadId: "$thread",
          ChatType: "channel",
          SessionKey: "agent:main:matrix:channel:!room:example.org",
        }),
        cfg,
      }),
    );
    expect(transcript).toEqual({
      transcript: "hello from voice",
      identity: { provider: "whisper", requestedBackend: "cpu" },
    });
  });

  it("carries backend identity into deferred echo delivery", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello from voice");
    const echoCfg = {
      tools: {
        media: {
          audio: {
            echoTranscript: true,
            echo: { match: { provider: "whisper" } },
          },
        },
      },
    } as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
    const result = await resolveMatrixPreflightAudioTranscript({
      mediaPath: "/tmp/inbound/voice.ogg",
      mediaContentType: "audio/ogg",
      cfg: echoCfg,
      accountId: "ops",
      chatType: "channel",
      originatingTo: "room:!room:example.org",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
    });
    expect(result).toBeDefined();

    if (result) {
      await sendMatrixPreflightAudioTranscriptEcho({
        transcript: result.transcript,
        identity: result.identity,
        cfg: echoCfg,
        accountId: "ops",
        originatingTo: "room:!room:example.org",
      });
    }

    expect(sendTranscriptEchoMock).toHaveBeenCalledOnce();
  });
});
