import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { shareTelegramVoiceTranscript } from "./audio-preflight-share.js";
import { transcribeFirstAudio } from "./audio-preflight.js";

const transcribe = vi.hoisted(() => vi.fn());
const echo = vi.hoisted(() => vi.fn());
vi.mock("./audio-transcription-runner.js", () => ({ runAudioTranscription: transcribe }));
vi.mock("./echo-transcript.js", () => ({
  DEFAULT_ECHO_TRANSCRIPT_FORMAT: "{transcript}",
  sendTranscriptEcho: echo,
}));

let nextMessageId = 100;

async function fixture(run: (paths: [string, string]) => Promise<void>) {
  await withTestDir({ prefix: "openclaw-voice-share-" }, async (dir) => {
    const paths: [string, string] = [path.join(dir, "a.ogg"), path.join(dir, "b.ogg")];
    await Promise.all(
      paths.map((file) => fs.writeFile(file, Buffer.from("synthetic voice bytes"))),
    );
    await run(paths);
  });
}

function request(params: {
  file: string;
  account: string;
  messageId: string;
  cfg?: OpenClawConfig;
  signal?: AbortSignal;
  chatId?: string;
}) {
  const ctx: MsgContext = {
    Provider: "telegram",
    Surface: "telegram",
    AccountId: params.account,
    OriginatingTo: "telegram:-123",
    media: [
      { path: params.file, contentType: "audio/ogg", workspaceDir: path.dirname(params.file) },
    ],
  };
  return {
    ctx,
    cfg: params.cfg ?? {},
    telegramVoice: { chatId: params.chatId ?? "-123", messageId: params.messageId },
    signal: params.signal,
  };
}

describe("Telegram voice preflight sharing", () => {
  beforeEach(() => {
    transcribe.mockReset();
    echo.mockReset();
  });

  it("transcribes identical cross-account voice once while each account owns echo and media state", async () => {
    await fixture(async ([a, b]) => {
      const messageId = String(nextMessageId++);
      const cfg: OpenClawConfig = { tools: { media: { audio: { echoTranscript: true } } } };
      let finish!: (value: { transcript: string }) => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      transcribe.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            started();
          }),
      );
      const first = request({ file: a, account: "alpha", messageId, cfg });
      const second = request({ file: b, account: "beta", messageId, cfg });
      const results = Promise.all([transcribeFirstAudio(first), transcribeFirstAudio(second)]);
      await startedPromise;
      finish({ transcript: "@alpha @beta hello" });
      expect(await results).toEqual(["@alpha @beta hello", "@alpha @beta hello"]);
      expect(transcribe).toHaveBeenCalledOnce();
      expect(echo).toHaveBeenCalledTimes(2);
      expect(first.ctx.media?.[0]?.transcribed).toBe(true);
      expect(second.ctx.media?.[0]?.transcribed).toBe(true);
      expect(
        await transcribeFirstAudio(request({ file: b, account: "gamma", messageId, cfg })),
      ).toBe("@alpha @beta hello");
      expect(transcribe).toHaveBeenCalledOnce();
    });
  });

  it("segregates changed audio, language, prompt, provider, privacy config, and message identity", async () => {
    await fixture(async ([a, b]) => {
      const messageId = String(nextMessageId++);
      transcribe.mockResolvedValue({ transcript: "heard" });
      const base = request({ file: a, account: "alpha", messageId });
      const variants = [
        request({
          file: b,
          account: "beta",
          messageId,
          cfg: { tools: { media: { audio: { language: "de" } } } },
        }),
        request({
          file: b,
          account: "beta",
          messageId,
          cfg: { tools: { media: { audio: { prompt: "names" } } } },
        }),
        request({
          file: b,
          account: "beta",
          messageId,
          cfg: { tools: { media: { models: [{ provider: "groq", capabilities: ["audio"] }] } } },
        }),
        request({
          file: b,
          account: "beta",
          messageId,
          cfg: { tools: { media: { audio: { scope: { default: "allow" } } } } },
        }),
        request({ file: b, account: "beta", messageId: `${messageId}-other` }),
        request({ file: b, account: "beta", messageId, chatId: "-456" }),
      ];
      await transcribeFirstAudio(base);
      for (const variant of variants) {
        await transcribeFirstAudio(variant);
      }
      expect(transcribe).toHaveBeenCalledTimes(1 + variants.length);
      await fs.writeFile(b, Buffer.from("different synthetic bytes"));
      await transcribeFirstAudio(request({ file: b, account: "beta", messageId }));
      expect(transcribe).toHaveBeenCalledTimes(2 + variants.length);
    });
  });

  it("evicts failed and empty results for retry", async () => {
    await fixture(async ([a, b]) => {
      const messageId = String(nextMessageId++);
      transcribe.mockRejectedValueOnce(new Error("synthetic STT failure"));
      transcribe.mockResolvedValueOnce({ transcript: undefined });
      transcribe.mockResolvedValueOnce({ transcript: "recovered" });
      const first = request({ file: a, account: "alpha", messageId });
      const second = request({ file: b, account: "beta", messageId });
      expect(await transcribeFirstAudio(first)).toBeUndefined();
      expect(await transcribeFirstAudio(second)).toBeUndefined();
      expect(await transcribeFirstAudio(first)).toBe("recovered");
      expect(transcribe).toHaveBeenCalledTimes(3);
    });
  });

  it("expires completed results after the bounded reuse window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const key = `synthetic-ttl-${nextMessageId++}`;
      const run = vi.fn().mockResolvedValue("heard");
      expect(await shareTelegramVoiceTranscript(key, run)).toBe("heard");
      now.mockReturnValue(30_999);
      expect(await shareTelegramVoiceTranscript(key, run)).toBe("heard");
      expect(run).toHaveBeenCalledOnce();
      now.mockReturnValue(31_001);
      expect(await shareTelegramVoiceTranscript(key, run)).toBe("heard");
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("lets one waiter cancel without stopping another account's transcription", async () => {
    await fixture(async ([a, b]) => {
      const messageId = String(nextMessageId++);
      let finish!: (value: { transcript: string }) => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      transcribe.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            started();
          }),
      );
      const controller = new AbortController();
      const first = transcribeFirstAudio(
        request({ file: a, account: "alpha", messageId, signal: controller.signal }),
      );
      const second = transcribeFirstAudio(request({ file: b, account: "beta", messageId }));
      await startedPromise;
      controller.abort();
      expect(await first).toBeUndefined();
      finish({ transcript: "still heard" });
      expect(await second).toBe("still heard");
      expect(transcribe).toHaveBeenCalledOnce();
    });
  });
});
