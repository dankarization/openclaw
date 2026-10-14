import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import { formatAudioTranscripts } from "../../packages/media-understanding-common/src/format.js";
// Audio preflight transcribes voice notes before mention checks and optionally
// echoes the transcript back to the source chat.
import type { RuntimeMsgContext as MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { normalizeMediaFacts } from "../media/media-facts.js";
import { isAudioAttachment } from "./attachments.js";
import {
  shareTelegramVoiceTranscript,
  telegramVoiceShareKey,
  type TelegramVoiceIdentity,
} from "./audio-preflight-share.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
  runCapability,
} from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  assertCurrent?: () => void;
  agentDir?: string;
  workspaceDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  telegramVoice?: TelegramVoiceIdentity;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const { ctx, cfg } = params;

  const audioConfig = cfg.tools?.media?.audio;
  if (audioConfig?.enabled === false) {
    return undefined;
  }

  const attachmentMedia = normalizeMediaFacts(ctx.media);
  const firstAudio = normalizeMediaAttachments(ctx).find(
    (att) => isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  try {
    const localPathRoots = resolveMediaAttachmentLocalRoots({ cfg, ctx });
    const transcribe = async () =>
      (
        await runAudioTranscription({
          ctx,
          cfg,
          assertCurrent: params.assertCurrent,
          attachments: [firstAudio],
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          providers: params.providers,
          activeModel: params.activeModel,
          localPathRoots,
        })
      ).transcript;
    const key =
      params.telegramVoice &&
      ctx.Provider === "telegram" &&
      ctx.Surface === "telegram" &&
      !params.workspaceDir &&
      !params.agentDir &&
      !params.providers &&
      !params.activeModel
        ? await telegramVoiceShareKey({
            identity: params.telegramVoice,
            attachment: firstAudio,
            cfg,
            sessionKey: ctx.SessionKey,
            chatType: ctx.ChatType,
            localPathRoots,
          })
        : undefined;
    const shared = key ? shareTelegramVoiceTranscript(key, transcribe) : transcribe();
    // A waiter may stop waiting, but its signal never reaches the shared runner.
    const transcript = params.signal
      ? await waitForTranscript(shared, params.signal)
      : await shared;
    // Shared transcription can outlive this request's admission while it waits.
    params.assertCurrent?.();
    if (!transcript) {
      return undefined;
    }

    if (audioConfig?.echoTranscript && attachmentMedia[firstAudio.index]?.source !== "quote") {
      await sendTranscriptEcho({
        ctx,
        cfg,
        transcript,
        format: audioConfig.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
      });
    }

    // Persist transcription state on the matching fact so later normalization
    // cannot shift or lose it through a parallel index list.
    const media = normalizeMediaFacts(ctx.media);
    const transcribedFact = media[firstAudio.index];
    if (transcribedFact) {
      media[firstAudio.index] = { ...transcribedFact, transcribed: true };
      ctx.media = media;
    }

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`,
      );
    }

    return transcript;
  } catch (err) {
    // Preflight cannot block message handling; mention checks can still run on text-only input.
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  }
}

function waitForTranscript(
  transcript: Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) {
    // The shared runner already owns work. Observe rejection even when this
    // caller stops waiting; cancellation never aborts another account's STT.
    void transcript.catch(() => undefined);
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    transcript.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Transcribes the configured audio selection before an internal user turn is staged. */
export async function transcribeAudioAttachments(
  params: Parameters<typeof transcribeFirstAudio>[0],
): Promise<string | undefined> {
  const { ctx, cfg } = params;

  const audioConfig = cfg.tools?.media?.audio;
  if (audioConfig?.enabled === false) {
    return undefined;
  }

  const attachments = normalizeMediaAttachments(ctx);
  const firstAudio = attachments.find((att) => isAudioAttachment(att) && !att.alreadyTranscribed);

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose("audio-preflight: transcribing configured audio selection");
  }

  try {
    const media = attachments;
    const { agentDir, providers, activeModel } = params;
    const localPathRoots = resolveMediaAttachmentLocalRoots({ cfg, ctx });
    const providerRegistry = buildProviderRegistry(providers, cfg);
    const cache = createMediaAttachmentCache(media, {
      localPathRoots,
      ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
    });
    let result: Awaited<ReturnType<typeof runCapability>>;
    try {
      result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        agentDir,
        workspaceDir: params.workspaceDir,
        assertCurrent: params.assertCurrent,
        providerRegistry,
        config: cfg.tools?.media?.audio,
        activeModel,
      });
    } finally {
      await cache.cleanup();
    }
    params.assertCurrent?.();
    // Retain selected and dropped indexes even without usable speech: the
    // later media pass must not repeat this completed selection budget.
    ctx.MediaUnderstandingDecisions = [...(ctx.MediaUnderstandingDecisions ?? []), result.decision];
    const audioOutputs = result.outputs.filter(
      (entry) => entry.kind === "audio.transcription" && entry.text.trim(),
    );
    const transcript = formatAudioTranscripts(audioOutputs).trim();
    if (!transcript) {
      return undefined;
    }

    const attachmentMedia = normalizeMediaFacts(ctx.media);
    const echoTranscript = formatAudioTranscripts(
      audioOutputs.filter((output) => attachmentMedia[output.attachmentIndex]?.source !== "quote"),
    ).trim();
    if (audioConfig?.echoTranscript && echoTranscript) {
      await sendTranscriptEcho({
        ctx,
        cfg,
        transcript: echoTranscript,
        format: audioConfig.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
      });
    }

    // Persist transcription state on the matching fact so later normalization
    // cannot shift or lose it through a parallel index list.
    const facts = normalizeMediaFacts(ctx.media);
    for (const output of audioOutputs) {
      const index = output.attachmentIndex;
      const fact = facts[index];
      if (fact) {
        facts[index] = { ...fact, transcribed: true };
      }
    }
    ctx.media = facts;

    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcribed ${transcript.length} chars`);
    }

    return transcript;
  } catch (err) {
    // Preflight cannot block message handling; mention checks can still run on text-only input.
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  }
}
