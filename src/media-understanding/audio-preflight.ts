import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
// Audio preflight transcribes voice notes before mention checks and optionally
// echoes the transcript back to the source chat.
import type { RuntimeMsgContext as MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { normalizeMediaFacts } from "../media/media-facts.js";
import { isAudioAttachment } from "./attachments.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import { type AudioTranscriptionIdentity, matchesAudioEchoIdentity } from "./echo-filter.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import { normalizeMediaAttachments, resolveMediaAttachmentLocalRoots } from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";

export type AudioPreflightResult = {
  transcript: string;
  identity?: AudioTranscriptionIdentity;
};

type AudioPreflightParams = {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  deferTranscriptEcho?: boolean;
};

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript plus executed backend identity, or undefined when
 * transcription fails or no audio is found.
 */
export async function resolveAudioPreflight(
  params: AudioPreflightParams,
): Promise<AudioPreflightResult | undefined> {
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
    const { transcript, identity } = await runAudioTranscription({
      ctx,
      cfg,
      attachments: [firstAudio],
      agentDir: params.agentDir,
      providers: params.providers,
      activeModel: params.activeModel,
      localPathRoots: resolveMediaAttachmentLocalRoots({ cfg, ctx }),
    });
    if (!transcript) {
      return undefined;
    }

    const echoMatch = audioConfig?.echo?.match;
    const shouldEcho =
      audioConfig?.echoTranscript &&
      matchesAudioEchoIdentity({ match: echoMatch, identity: identity ?? {} });
    if (shouldEcho && !params.deferTranscriptEcho) {
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

    return { transcript, identity };
  } catch (err) {
    // Preflight cannot block message handling; mention checks can still run on text-only input.
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  }
}

/** Compatibility wrapper returning only the transcript text. */
export async function transcribeFirstAudio(
  params: Omit<AudioPreflightParams, "deferTranscriptEcho">,
): Promise<string | undefined> {
  return (await resolveAudioPreflight(params))?.transcript;
}
