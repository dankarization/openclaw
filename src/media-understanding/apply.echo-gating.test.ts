// Apply echo backend-gating tests cover identity-filtered transcript echo:
// local CLI Whisper echoes, cloud fallback does not, agent input is unchanged,
// and delivery carries reply-to metadata for supported channels.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type ResolveApiKeyForProvider =
  typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore;

const resolveApiKeyForProviderCoreMock = vi.hoisted(() =>
  vi.fn<ResolveApiKeyForProvider>(async () => ({
    apiKey: "***", // pragma: allowlist secret
    source: "test",
    mode: "api-key",
  })),
);
const hasAvailableAuthForProviderMock = vi.hoisted(() =>
  vi.fn(async (...args: Parameters<ResolveApiKeyForProvider>) => {
    const resolved = await resolveApiKeyForProviderCoreMock(...args);
    return Boolean(resolved?.apiKey);
  }),
);
const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());
const runExecMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;

const TEMP_MEDIA_PREFIX = "openclaw-echo-gating-test-";
let suiteTempMediaRootDir = "";

async function createTempAudioFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "case-"));
  const filePath = path.join(dir, "note.ogg");
  await fs.writeFile(filePath, createSafeAudioFixtureBuffer(2048));
  return filePath;
}

function createTelegramAudioCtx(mediaPath: string, extra?: Partial<MsgContext>): MsgContext {
  return {
    Body: "",
    media: [{ path: mediaPath, contentType: "audio/ogg" }],
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:42",
    From: "telegram:42",
    AccountId: "primary",
    MessageSid: "501",
    MessageSidFull: "telegram:42:501",
    ...extra,
  };
}

/** CLI whisper (Python) entry with stdout transcript output. */
function createLocalWhisperCliConfig(echoMatch: { provider: string }): OpenClawConfig {
  return {
    tools: {
      media: {
        models: [
          {
            type: "cli",
            command: "whisper",
            args: ["{{MediaPath}}"],
            capabilities: ["audio"],
          },
        ],
        audio: {
          enabled: true,
          maxBytes: 1024 * 1024,
          echoTranscript: true,
          echo: { match: echoMatch },
        },
      },
    },
  };
}

/** Cloud-provider first, local whisper CLI fallback. */
function createCloudFirstWithLocalFallbackConfig(): OpenClawConfig {
  return {
    tools: {
      media: {
        models: [
          { provider: "gigaam", capabilities: ["audio"] },
          {
            type: "cli",
            command: "whisper",
            args: ["{{MediaPath}}"],
            capabilities: ["audio"],
          },
        ],
        audio: {
          enabled: true,
          maxBytes: 1024 * 1024,
          echoTranscript: true,
          echo: { match: { provider: "whisper" } },
        },
      },
    },
  };
}

function mockWhisperCliStdout(transcript: string) {
  runExecMock.mockImplementation(async (command: string) => {
    if (command === "whisper") {
      return { stdout: `${transcript}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

function createGigaamProviders(
  text = "cloud transcript",
): Record<string, MediaUnderstandingProvider> {
  return {
    gigaam: {
      id: "gigaam",
      capabilities: ["audio"],
      transcribeAudio: async () => ({ text }),
    },
  };
}

function expectSingleEchoDeliveryCall() {
  expect(mockDeliverOutboundPayloads).toHaveBeenCalledTimes(1);
  const firstCall = mockDeliverOutboundPayloads.mock.calls[0];
  if (!firstCall) {
    throw new Error("Expected echo transcript delivery call");
  }
  const callArgs = firstCall[0] as {
    to?: string;
    channel?: string;
    accountId?: string;
    payloads: Array<{ text?: string; replyToId?: string }>;
  };
  if (!callArgs) {
    throw new Error("Expected echo transcript delivery call args");
  }
  return callArgs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyMediaUnderstanding – echo backend gating", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("../agents/model-auth.js", () => ({
      resolveApiKeyForProviderCore: resolveApiKeyForProviderCoreMock,
      hasAvailableAuthForProvider: hasAvailableAuthForProviderMock,
      isProviderAuthError: (err: unknown, code?: string) =>
        err instanceof Error &&
        "code" in err &&
        (code === undefined || (err as { code?: unknown }).code === code),
      requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
        if (auth?.apiKey) {
          return auth.apiKey;
        }
        const err = new Error(
          `No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`,
        );
        (err as { code?: string; provider?: string }).code = "missing-api-key";
        (err as { code?: string; provider?: string }).provider = provider;
        throw err;
      },
      resolveAwsSdkEnvVarName: vi.fn(() => undefined),
      resolveEnvApiKey: vi.fn(() => null),
      resolveModelAuthMode: vi.fn(() => "api-key"),
      getApiKeyForModelCore: vi.fn(async () => ({
        apiKey: "***", // pragma: allowlist secret
        source: "test",
        mode: "api-key",
      })),
      getCustomProviderApiKey: vi.fn(() => undefined),
      ensureAuthProfileStore: vi.fn(async () => ({})),
      resolveAuthProfileOrder: vi.fn(() => []),
    }));
    vi.doMock("../media/fetch.js", () => ({
      readRemoteMediaBuffer: readRemoteMediaBufferMock,
    }));
    vi.doMock("../process/exec.js", () => ({
      runExec: runExecMock,
      runCommandWithTimeout: runCommandWithTimeoutMock,
    }));
    vi.doMock("../channels/message/runtime.js", () => ({
      sendDurableMessageBatchCore: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
    }));
    vi.doMock("../utils/message-channel.js", () => ({
      isDeliverableMessageChannel: (channel: string) => channel === "telegram",
    }));
    vi.doMock("./provider-registry.js", async () => {
      const actual =
        await vi.importActual<typeof import("./provider-registry.js")>("./provider-registry.js");
      return {
        ...actual,
        buildMediaUnderstandingRegistry: (
          overrides?: Record<string, MediaUnderstandingProvider>,
        ) => {
          const registry = new Map<string, MediaUnderstandingProvider>();
          for (const [key, provider] of Object.entries(overrides ?? {})) {
            const normalizedKey = actual.normalizeMediaProviderId(key);
            registry.set(normalizedKey, {
              ...provider,
              capabilities: provider.capabilities ?? ["audio"],
            });
          }
          return registry;
        },
      };
    });

    const baseDir = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(baseDir, { recursive: true });
    suiteTempMediaRootDir = await fs.mkdtemp(path.join(baseDir, TEMP_MEDIA_PREFIX));
    const mod = await import("./apply.js");
    applyMediaUnderstanding = mod.applyMediaUnderstanding;
  });

  beforeEach(() => {
    resolveApiKeyForProviderCoreMock.mockClear();
    hasAvailableAuthForProviderMock.mockClear();
    readRemoteMediaBufferMock.mockClear();
    runExecMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    mockDeliverOutboundPayloads.mockClear();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "telegram", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
  });

  afterAll(async () => {
    if (!suiteTempMediaRootDir) {
      return;
    }
    await fs.rm(suiteTempMediaRootDir, { recursive: true, force: true });
    suiteTempMediaRootDir = "";
  });

  it("echoes local whisper CLI success exactly once with [Transcription] format and replyToId", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createTelegramAudioCtx(mediaPath);
    const cfg = createLocalWhisperCliConfig({ provider: "whisper" });
    mockWhisperCliStdout("local whisper result");

    await applyMediaUnderstanding({ ctx, cfg });

    // Echo delivered exactly once with the exact operator-visible format and
    // reply-to metadata for the source message.
    const callArgs = expectSingleEchoDeliveryCall();
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.to).toBe("telegram:42");
    expect(callArgs.accountId).toBe("primary");
    expect(callArgs.payloads).toHaveLength(1);
    expect(callArgs.payloads[0]?.text).toBe("[Transcription]\nlocal whisper result");
    expect(callArgs.payloads[0]?.replyToId).toBe("telegram:42:501");

    // The transcript continues unchanged into normal agent processing.
    expect(ctx.Transcript).toBe("local whisper result");
    expect(ctx.CommandBody).toBe("local whisper result");
    expect(ctx.RawBody).toBe("local whisper result");
  });

  it("does NOT echo a cloud fallback success when configured local-whisper-only", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createTelegramAudioCtx(mediaPath);
    const cfg = createCloudFirstWithLocalFallbackConfig();
    // Cloud provider succeeds first; local whisper CLI never runs.
    const providers = createGigaamProviders("cloud gigaam transcript");

    await applyMediaUnderstanding({ ctx, cfg, providers });

    // No echo: successful backend identity (gigaam) does not match the
    // configured local whisper filter.
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();

    // Agent processing still receives the cloud transcript unchanged.
    expect(ctx.Transcript).toBe("cloud gigaam transcript");
    expect(ctx.CommandBody).toBe("cloud gigaam transcript");
  });

  it("echoes local whisper fallback after cloud failure when configured local-only", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createTelegramAudioCtx(mediaPath);
    const cfg = createCloudFirstWithLocalFallbackConfig();
    const providers: Record<string, MediaUnderstandingProvider> = {
      gigaam: {
        id: "gigaam",
        capabilities: ["audio"],
        transcribeAudio: async () => {
          throw new Error("gigaam unavailable");
        },
      },
    };
    mockWhisperCliStdout("fallback local result");

    await applyMediaUnderstanding({ ctx, cfg, providers });

    const callArgs = expectSingleEchoDeliveryCall();
    expect(callArgs.payloads[0]?.text).toBe("[Transcription]\nfallback local result");
    expect(ctx.Transcript).toBe("fallback local result");
  });

  it("does NOT echo local whisper success when echoTranscript is disabled", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createTelegramAudioCtx(mediaPath);
    const cfg = createLocalWhisperCliConfig({ provider: "whisper" });
    const audio = expectDefined(cfg.tools?.media?.audio, "audio config test invariant");
    audio.echoTranscript = false;
    mockWhisperCliStdout("silent local result");

    await applyMediaUnderstanding({ ctx, cfg });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
    expect(ctx.Transcript).toBe("silent local result");
  });

  it("does not double-echo when preflight already echoed the same attachment", async () => {
    // Simulate the preflight path having already transcribed the attachment:
    // the media fact is marked transcribed so apply's audio capability skips it.
    const mediaPath = await createTempAudioFile();
    const ctx = createTelegramAudioCtx(mediaPath, {
      media: [{ path: mediaPath, contentType: "audio/ogg", transcribed: true }],
    });
    const cfg = createLocalWhisperCliConfig({ provider: "whisper" });
    mockWhisperCliStdout("preflight transcript");

    await applyMediaUnderstanding({ ctx, cfg });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
