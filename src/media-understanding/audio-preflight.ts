import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
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
import { normalizeMediaAttachments, resolveMediaAttachmentLocalRoots } from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
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

  const attachments = normalizeMediaAttachments(ctx);
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const firstAudio = attachments.find(
    (att) => att && isAudioAttachment(att) && !att.alreadyTranscribed,
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
          attachments: [firstAudio],
          agentDir: params.agentDir,
          providers: params.providers,
          activeModel: params.activeModel,
          localPathRoots,
        })
      ).transcript;
    const key =
      params.telegramVoice &&
      ctx.Provider === "telegram" &&
      ctx.Surface === "telegram" &&
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
    if (!transcript) {
      return undefined;
    }

    if (audioConfig?.echoTranscript) {
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
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    transcript.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
